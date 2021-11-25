import { AdminRoom, BRIDGE_ROOM_TYPE, AdminAccountData } from "./AdminRoom";
import { Appservice, IAppserviceRegistration, RichRepliesPreprocessor, IRichReplyMetadata, StateEvent, PantalaimonClient, MatrixClient } from "matrix-bot-sdk";
import { BridgeConfig, BridgeConfigProvisioning, GitLabInstance } from "./Config/Config";
import { BridgeWidgetApi } from "./Widgets/BridgeWidgetApi";
import { CommentProcessor } from "./CommentProcessor";
import { ConnectionManager } from "./ConnectionManager";
import { GetIssueResponse, GetIssueOpts } from "./Gitlab/Types"
import { GithubInstance } from "./Github/GithubInstance";
import { GitHubIssueConnection } from "./Connections/GithubIssue";
import { GitHubProjectConnection } from "./Connections/GithubProject";
import { GitHubRepoConnection } from "./Connections/GithubRepo";
import { GitLabIssueConnection } from "./Connections/GitlabIssue";
import { IBridgeStorageProvider } from "./Stores/StorageProvider";
import { IConnection, GitHubDiscussionSpace, GitHubDiscussionConnection, GitHubUserSpace } from "./Connections";
import { IGitLabWebhookIssueStateEvent, IGitLabWebhookMREvent, IGitLabWebhookNoteEvent } from "./Gitlab/WebhookTypes";
import { JiraIssueEvent } from "./Jira/WebhookTypes";
import { MatrixEvent, MatrixMemberContent, MatrixMessageContent } from "./MatrixEvent";
import { MemoryStorageProvider } from "./Stores/MemoryStorageProvider";
import { MessageQueue, createMessageQueue } from "./MessageQueue/MessageQueue";
import { MessageSenderClient } from "./MatrixSender";
import { NotifFilter, NotificationFilterStateContent } from "./NotificationFilters";
import { NotificationProcessor } from "./NotificationsProcessor";
import { OAuthRequest, OAuthTokens, NotificationsEnableEvent, NotificationsDisableEvent, GenericWebhookEvent,} from "./Webhooks";
import { ProjectsGetResponseData } from "./Github/Types";
import { RedisStorageProvider } from "./Stores/RedisStorageProvider";
import { retry } from "./PromiseUtil";
import { UserNotificationsEvent } from "./Notifications/UserNotificationWatcher";
import { UserTokenStore } from "./UserTokenStore";
import * as GitHubWebhookTypes from "@octokit/webhooks-types";
import LogWrapper from "./LogWrapper";
import { Provisioner } from "./provisioning/provisioner";
const log = new LogWrapper("Bridge");

export class Bridge {
    private readonly as: Appservice;
    private readonly storage: IBridgeStorageProvider;
    private readonly messageClient: MessageSenderClient;
    private readonly queue: MessageQueue;
    private readonly commentProcessor: CommentProcessor;
    private readonly notifProcessor: NotificationProcessor;
    private readonly tokenStore: UserTokenStore;
    private connectionManager?: ConnectionManager;
    private github?: GithubInstance;
    private encryptedMatrixClient?: MatrixClient;
    private adminRooms: Map<string, AdminRoom> = new Map();
    private widgetApi: BridgeWidgetApi = new BridgeWidgetApi(this.adminRooms);
    private provisioningApi?: Provisioner;

    private ready = false;

    constructor(private config: BridgeConfig, private registration: IAppserviceRegistration) {
        if (this.config.queue.host && this.config.queue.port) {
            log.info(`Initialising Redis storage (on ${this.config.queue.host}:${this.config.queue.port})`);
            this.storage = new RedisStorageProvider(this.config.queue.host, this.config.queue.port);
        } else {
            log.info('Initialising memory storage');
            this.storage = new MemoryStorageProvider();
        }
        this.as = new Appservice({
            homeserverName: this.config.bridge.domain,
            homeserverUrl: this.config.bridge.url,
            port: this.config.bridge.port,
            bindAddress: this.config.bridge.bindAddress,
            registration: this.registration,
            storage: this.storage,
        });
        this.queue = createMessageQueue(this.config);
        this.messageClient = new MessageSenderClient(this.queue);
        this.commentProcessor = new CommentProcessor(this.as, this.config.bridge.mediaUrl || this.config.bridge.url);
        this.notifProcessor = new NotificationProcessor(this.storage, this.messageClient);
        this.tokenStore = new UserTokenStore(this.config.passFile || "./passkey.pem", this.as.botIntent);
    }

    public stop() {
        this.as.stop();
        if (this.queue.stop) this.queue.stop();
        if (this.widgetApi) this.widgetApi.stop();
        if (this.provisioningApi) this.provisioningApi.stop();
    }

    public async start() {
        log.info('Starting up');

        if (!this.config.github && !this.config.gitlab && !this.config.jira) {
            log.error("You haven't configured support for GitHub or GitLab!");
            throw Error('Bridge cannot start -- no connectors are configured');
        }

        if (this.config.github) {
            this.github = new GithubInstance(this.config.github);
            await this.github.start();
        }

        this.as.expressAppInstance.get("/live", (_, res) => res.send({ok: true}));
        this.as.expressAppInstance.get("/ready", (_, res) => res.status(this.ready ? 200 : 500).send({ready: this.ready}));

        if (this.config.bridge.pantalaimon) {
            log.info(`Loading pantalaimon client`);
            const pan = new PantalaimonClient(
                this.config.bridge.pantalaimon.url,
                this.storage,
            );
            this.encryptedMatrixClient = await pan.createClientWithCredentials(
                this.config.bridge.pantalaimon.username,
                this.config.bridge.pantalaimon.password
            );
            this.encryptedMatrixClient.on("room.message", async (roomId, event) => {
                return this.onRoomMessage(roomId, event);
            });
            // TODO: Filter
            await this.encryptedMatrixClient.start();
            log.info(`Pan client is syncing`);
        }


        await this.tokenStore.load();
        const connManager = this.connectionManager = new ConnectionManager(this.as,
            this.config, this.tokenStore, this.commentProcessor, this.messageClient, this.github);
    
        if (this.config.provisioning) {
            this.provisioningApi = new Provisioner(this.config.provisioning, this.connectionManager, this.as.botIntent);
        }

        this.as.on("query.room", async (roomAlias, cb) => {
            try {
                cb(await this.onQueryRoom(roomAlias));
            } catch (ex) {
                log.error("Failed to create room:", ex);
                cb(false);
            }
        });

        this.as.on("room.invite", async (roomId, event) => {
            return this.onRoomInvite(roomId, event);
        });

        this.as.on("room.message", async (roomId, event) => {
            return this.onRoomMessage(roomId, event);
        });

        this.as.on("room.event", async (roomId, event) => {
            return this.onRoomEvent(roomId, event);
        });

        this.as.on("room.join", async (roomId, event) => {
            return this.onRoomJoin(roomId, event);
        });

        this.queue.subscribe("response.matrix.message");
        this.queue.subscribe("notifications.user.events");
        this.queue.subscribe("github.*");
        this.queue.subscribe("gitlab.*");

        const validateRepoIssue = (data: GitHubWebhookTypes.IssuesEvent|GitHubWebhookTypes.IssueCommentEvent) => {
            if (!data.repository || !data.issue) {
                throw Error("Malformed webhook event, missing repository or issue");
            }
            if (!data.repository.owner?.login) {
                throw Error('Cannot get connection for ownerless issue');
            }
            return {
                owner: data.repository.owner?.login,
                repository: data.repository,
                issue: data.issue,
            };
        }

        this.queue.on<GitHubWebhookTypes.IssueCommentCreatedEvent>("github.issue_comment.created", async ({ data }) => {
            const { repository, issue, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubIssue(owner, repository.name, issue.number);
            connections.map(async (c) => {
                try {
                    if (c instanceof GitHubIssueConnection)
                        await c.onIssueCommentCreated(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issue_comment.created:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.IssuesOpenedEvent>("github.issues.opened", async ({ data }) => {
            const { repository, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubRepo(owner, repository.name);
            connections.map(async (c) => {
                try {
                    await c.onIssueCreated(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issues.opened:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.IssuesEditedEvent>("github.issues.edited", async ({ data }) => {
            const { repository, issue, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubIssue(owner, repository.name, issue.number);
            connections.map(async (c) => {
                try {
                    // TODO: Needs impls
                    if (c instanceof GitHubIssueConnection /* || c instanceof GitHubRepoConnection*/)
                        await c.onIssueEdited(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issues.edited:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.IssuesClosedEvent>("github.issues.closed", async ({ data }) => {
            const { repository, issue, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubIssue(owner, repository.name, issue.number);
            connections.map(async (c) => {
                try {
                    if (c instanceof GitHubIssueConnection || c instanceof GitHubRepoConnection)
                        await c.onIssueStateChange(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issues.closed:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.IssuesReopenedEvent>("github.issues.reopened", async ({ data }) => {
            const { repository, issue, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubIssue(owner, repository.name, issue.number);
            connections.map(async (c) => {
                try {
                    if (c.onIssueStateChange) {
                        await c.onIssueStateChange(data);
                    }
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issues.reopened:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.IssuesEditedEvent>("github.issues.edited", async ({ data }) => {
            const { repository, owner } = validateRepoIssue(data);
            const connections = connManager.getConnectionsForGithubRepo(owner, repository.name);
            connections.map(async (c) => {
                try {
                    await c.onIssueEdited(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.issues.edited:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.PullRequestOpenedEvent>("github.pull_request.opened", async ({ data }) => {
            const connections = connManager.getConnectionsForGithubRepo(data.repository.owner.login, data.repository.name);
            connections.map(async (c) => {
                try {
                    await c.onPROpened(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.pull_request.opened:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.PullRequestClosedEvent>("github.pull_request.closed", async ({ data }) => {
            const connections = connManager.getConnectionsForGithubRepo(data.repository.owner.login, data.repository.name);
            connections.map(async (c) => {
                try {
                    await c.onPRClosed(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.pull_request.closed:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.PullRequestReadyForReviewEvent>("github.pull_request.ready_for_review", async ({ data }) => {
            const connections = connManager.getConnectionsForGithubRepo(data.repository.owner.login, data.repository.name);
            connections.map(async (c) => {
                try {
                    await c.onPRReadyForReview(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.pull_request.closed:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.PullRequestReviewSubmittedEvent>("github.pull_request_review.submitted", async ({ data }) => {
            const connections = connManager.getConnectionsForGithubRepo(data.repository.owner.login, data.repository.name);
            connections.map(async (c) => {
                try {
                    await c.onPRReviewed(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.pull_request.closed:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.ReleaseCreatedEvent>("github.release.created", async ({ data }) => {
            const connections = connManager.getConnectionsForGithubRepo(data.repository.owner.login, data.repository.name);
            connections.map(async (c) => {
                try {
                    await c.onReleaseCreated(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle github.pull_request.closed:`, ex);
                }
            })
        });

        this.queue.on<IGitLabWebhookMREvent>("gitlab.merge_request.open", async (msg) => {
            const connections = connManager.getConnectionsForGitLabRepo(msg.data.project.path_with_namespace);
            connections.map(async (c) => {
                try {
                    await c.onMergeRequestOpened(msg.data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle gitlab.merge_request.open:`, ex);
                }
            })
        });

        this.queue.on<IGitLabWebhookMREvent>("gitlab.tag_push", async (msg) => {
            const connections = connManager.getConnectionsForGitLabRepo(msg.data.project.path_with_namespace);
            connections.map(async (c) => {
                try {
                    await c.onMergeRequestOpened(msg.data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle gitlab.tag_push:`, ex);
                }
            })
        });

        this.queue.on<UserNotificationsEvent>("notifications.user.events", async (msg) => {
            const adminRoom = this.adminRooms.get(msg.data.roomId);
            if (!adminRoom) {
                log.warn("No admin room for this notif stream!");
                return;
            }
            await this.notifProcessor.onUserEvents(msg.data, adminRoom);
        });

        this.queue.on<OAuthRequest>("oauth.response", async (msg) => {
            const adminRoom = [...this.adminRooms.values()].find((r) => r.oauthState === msg.data.state);
            await this.queue.push<boolean>({
                data: !!(adminRoom),
                sender: "Bridge",
                messageId: msg.messageId,
                eventName: "response.oauth.response",
            });
        });

        this.queue.on<OAuthTokens>("oauth.tokens", async (msg) => {
            const adminRoom = [...this.adminRooms.values()].find((r) => r.oauthState === msg.data.state);
            if (!adminRoom) {
                log.warn("Could not find admin room for successful tokens request. This shouldn't happen!");
                return;
            }
            adminRoom.clearOauthState();
            await this.tokenStore.storeUserToken("github", adminRoom.userId, msg.data.access_token);
        });

        this.queue.on<IGitLabWebhookNoteEvent>("gitlab.note.created", async ({data}) => {
            const connections = connManager.getConnectionsForGitLabIssueWebhook(data.repository.homepage, data.issue.iid);
            connections.map(async (c) => {
                try {
                    if (c.onCommentCreated)
                        await c.onCommentCreated(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle comment.created:`, ex);
                }
            })
        });

        this.queue.on<IGitLabWebhookIssueStateEvent>("gitlab.issue.reopen", async ({data}) => {
            const connections = connManager.getConnectionsForGitLabIssueWebhook(data.repository.homepage, data.object_attributes.iid);
            connections.map(async (c) => {
                try {
                    await c.onIssueReopened();
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle comment.created:`, ex);
                }
            })
        });

        this.queue.on<IGitLabWebhookIssueStateEvent>("gitlab.issue.close", async ({data}) => {
            const connections = connManager.getConnectionsForGitLabIssueWebhook(data.repository.homepage, data.object_attributes.iid);
            connections.map(async (c) => {
                try {
                    await c.onIssueClosed();
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle comment.created:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.DiscussionCommentCreatedEvent>("github.discussion_comment.created", async ({data}) => {
            const connections = connManager.getConnectionsForGithubDiscussion(data.repository.owner.login, data.repository.name, data.discussion.number);
            connections.map(async (c) => {
                try {
                    await c.onDiscussionCommentCreated(data);
                } catch (ex) {
                    log.warn(`Connection ${c.toString()} failed to handle comment.created:`, ex);
                }
            })
        });

        this.queue.on<GitHubWebhookTypes.DiscussionCreatedEvent>("github.discussion.created", async ({data}) => {
            if (!this.github) {
                return;
            }
            const spaces = connManager.getConnectionsForGithubRepoDiscussion(data.repository.owner.login, data.repository.name);
            if (spaces.length === 0) {
                log.info(`Not creating discussion ${data.discussion.id} ${data.repository.owner.login}/${data.repository.name}, no target spaces`);
                // We don't want to create any discussions if we have no target spaces.
                return;
            }
            let [discussionConnection] = connManager.getConnectionsForGithubDiscussion(data.repository.owner.login, data.repository.name, data.discussion.id);
            if (!discussionConnection) {
                try {
                    // If we don't have an existing connection for this discussion (likely), then create one.
                    discussionConnection = await GitHubDiscussionConnection.createDiscussionRoom(
                        this.as,
                        null,
                        data.repository.owner.login,
                        data.repository.name,
                        data.discussion,
                        this.tokenStore,
                        this.commentProcessor,
                        this.messageClient,
                    );
                    connManager.push(discussionConnection);
                } catch (ex) {
                    log.error(ex);
                    throw Error('Failed to create discussion room');
                }
            }

            spaces.map(async (c) => {
                try {
                    await c.onDiscussionCreated(discussionConnection);
                } catch (ex) {
                    log.warn(`Failed to add discussion ${c.toString()} failed to handle comment.created:`, ex);
                }
            })
        });

        this.queue.on<JiraIssueEvent>("jira.issue_created", async ({data}) => {
            log.info(`JIRA issue created for project ${data.issue.fields.project.id}, issue id ${data.issue.id}`);
            const projectId = data.issue.fields.project.id;
            const connections = connManager.getConnectionsForJiraProject(projectId, "jira.issue_created");

            connections.forEach(async (c) => {
                try {
                    await c.onJiraIssueCreated(data);
                } catch (ex) {
                    log.warn(`Failed to handle jira.issue_created:`, ex);
                }
            });
        });
    
        this.queue.on<GenericWebhookEvent>("generic-webhook.event", async ({data}) => {
            log.info(`Incoming generic hook ${data.hookId}`);
            const connections = connManager.getConnectionsForGenericWebhook(data.hookId);

            connections.forEach(async (c) => {
                try {
                    await c.onGenericHook(data.hookData);
                } catch (ex) {
                    log.warn(`Failed to handle generic-webhook.event:`, ex);
                }
            });
        });

        // Fetch all room state
        let joinedRooms: string[]|undefined;
        while(joinedRooms === undefined) {
            try {
                log.info("Connecting to homeserver and fetching joined rooms..");
                joinedRooms = await this.as.botIntent.underlyingClient.getJoinedRooms();
                log.info(`Found ${joinedRooms.length} rooms`);
            } catch (ex) {
                // This is our first interaction with the homeserver, so wait if it's not ready yet.
                log.warn("Failed to connect to homeserver:", ex, "retrying in 5s");
                await new Promise((r) => setTimeout(r, 5000));
            }
        }

        // Set the name and avatar of the bot
        if (this.config.bot) {
            // Ensure we are registered before we set a profile
            await this.as.botIntent.ensureRegistered();
            let profile;
            try {
                profile = await this.as.botClient.getUserProfile(this.as.botUserId);
            } catch {
                profile = {}
            }
            if (this.config.bot.avatar && profile.avatar_url !== this.config.bot.avatar) {
                log.info(`Setting avatar to ${this.config.bot.avatar}`);
                await this.as.botClient.setAvatarUrl(this.config.bot.avatar);
            }
            if (this.config.bot.displayname && profile.displayname !== this.config.bot.displayname) {
                log.info(`Setting displayname to ${this.config.bot.displayname}`);
                await this.as.botClient.setDisplayName(this.config.bot.displayname);
            }
        }

        for (const roomId of joinedRooms) {
            log.debug("Fetching state for " + roomId);
            let connections: IConnection[];
            try {
                connections = await connManager.createConnectionsForRoomId(roomId);
            } catch (ex) {
                log.error(`Unable to create connection for ${roomId}`, ex);
                continue;
            }
            if (connections.length) {
                log.info(`Room ${roomId} is connected to: ${connections.join(',')}`);
                connManager.push(...connections);
                continue;
            }

            // TODO: Refactor this to be a connection
            try {
                const accountData = await this.as.botIntent.underlyingClient.getSafeRoomAccountData<AdminAccountData>(
                    BRIDGE_ROOM_TYPE, roomId,
                );
                if (!accountData) {
                    log.debug(`Room ${roomId} has no connections and is not an admin room`);
                    continue;
                }

                let notifContent;
                try {
                    notifContent = await this.as.botIntent.underlyingClient.getRoomStateEvent(
                        roomId, NotifFilter.StateType, "",
                    );
                } catch (ex) {
                    try {
                        notifContent = await this.as.botIntent.underlyingClient.getRoomStateEvent(
                            roomId, NotifFilter.LegacyStateType, "",
                        );
                    }
                    catch (ex) {
                        // No state yet
                    }
                }
                const adminRoom = await this.setupAdminRoom(roomId, accountData, notifContent || NotifFilter.getDefaultContent());
                // Call this on startup to set the state
                await this.onAdminRoomSettingsChanged(adminRoom, accountData, { admin_user: accountData.admin_user });
                log.info(`Room ${roomId} is connected to: ${adminRoom.toString()}`);
            } catch (ex) {
                log.error(`Failed to setup admin room ${roomId}:`, ex);
            }
        }

        // Handle spaces
        for (const discussion of connManager.getAllConnectionsOfType(GitHubDiscussionSpace)) {
            const user = connManager.getConnectionForGithubUser(discussion.owner);
            if (user) {
                await user.ensureDiscussionInSpace(discussion);
            }
        }

        if (this.config.widgets) {
            await this.widgetApi.start(this.config.widgets.port);
        }
        if (this.provisioningApi) {
            await this.provisioningApi.listen();
        }
        await this.as.begin();
        log.info("Started bridge");
        this.ready = true;
    }

    private async onRoomInvite(roomId: string, event: MatrixEvent<MatrixMemberContent>) {
        if (this.as.isNamespacedUser(event.sender)) {
            /* Do not handle invites from our users */
            return;
        }
        log.info(`Got invite roomId=${roomId} from=${event.sender} to=${event.state_key}`);
        // Room joins can fail over federation
        if (event.state_key !== this.as.botUserId) {
            return this.as.botIntent.underlyingClient.kickUser(this.as.botUserId, roomId, "Bridge does not support DMing ghosts");
        }
        await retry(() => this.as.botIntent.joinRoom(roomId), 5);
        if (event.content.is_direct) {
            const room = await this.setupAdminRoom(roomId, {admin_user: event.sender}, NotifFilter.getDefaultContent());
            await this.as.botIntent.underlyingClient.setRoomAccountData(
                BRIDGE_ROOM_TYPE, roomId, room.accountData,
            );
        }
        // This is a group room, don't add the admin settings and just sit in the room.
    }

    private async onRoomMessage(roomId: string, event: MatrixEvent<MatrixMessageContent>) {
        if (!this.connectionManager) {
            // Not ready yet.
            return;
        }
        if (this.as.isNamespacedUser(event.sender)) {
            /* We ignore messages from our users */
            return;
        }
        if (Date.now() - event.origin_server_ts > 30000) {
            /* We ignore old messages too */
            return;
        }
        log.info(`Got message roomId=${roomId} type=${event.type} from=${event.sender}`);
        log.debug("Content:", JSON.stringify(event));
        const adminRoom = this.adminRooms.get(roomId);

        if (adminRoom) {
            if (adminRoom.userId !== event.sender) {
                return;
            }

            const replyProcessor = new RichRepliesPreprocessor(true);
            const processedReply = await replyProcessor.processEvent(event, this.as.botClient);

            if (processedReply) {
                const metadata: IRichReplyMetadata = processedReply.mx_richreply;
                log.info(`Handling reply to ${metadata.parentEventId} for ${adminRoom.userId}`);
                // This might be a reply to a notification
                try {
                    const ev = metadata.realEvent;
                    const splitParts: string[] = ev.content["uk.half-shot.matrix-hookshot.github.repo"]?.name.split("/");
                    const issueNumber = ev.content["uk.half-shot.matrix-hookshot.github.issue"]?.number;
                    if (splitParts && issueNumber) {
                        log.info(`Handling reply for ${splitParts}${issueNumber}`);
                        const connections = this.connectionManager.getConnectionsForGithubIssue(splitParts[0], splitParts[1], issueNumber);
                        await Promise.all(connections.map(async c => {
                            if (c instanceof GitHubIssueConnection) {
                                return c.onMatrixIssueComment(processedReply);
                            }
                        }));
                    } else {
                        log.info("Missing parts!:", splitParts, issueNumber);
                    }
                } catch (ex) {
                    await adminRoom.sendNotice("Failed to handle repy. You may not be authenticated to do that.");
                    log.error("Reply event could not be handled:", ex);
                }
                return;
            }

            const command = event.content.body;
            if (command) {
                await adminRoom.handleCommand(event.event_id, command);
            }
        }

        for (const connection of this.connectionManager.getAllConnectionsForRoom(roomId)) {
            try {
                if (connection.onMessageEvent) {
                    await connection.onMessageEvent(event);
                }
            } catch (ex) {
                log.warn(`Connection ${connection.toString()} failed to handle message:`, ex);
            }
        }
    }

    private async onRoomJoin(roomId: string, matrixEvent: MatrixEvent<MatrixMemberContent>) {
        if (this.as.botUserId !== matrixEvent.sender) {
            // Only act on bot joins
            return;
        }
        if (!this.connectionManager) {
            // Not ready yet.
            return;
        }

        // Only fetch rooms we have no connections in yet.
        if (!this.connectionManager.isRoomConnected(roomId)) {
            const connections = await this.connectionManager.createConnectionsForRoomId(roomId);
            this.connectionManager.push(...connections);
        }
    }

    private async onRoomEvent(roomId: string, event: MatrixEvent<unknown>) {
        if (!this.connectionManager) {
            // Not ready yet.
            return;
        }
        if (event.state_key) {
            // A state update, hurrah!
            const existingConnections = this.connectionManager.getInterestedForRoomState(roomId, event.type, event.state_key);
            for (const connection of existingConnections) {
                try {
                    if (connection?.onStateUpdate) {
                        connection.onStateUpdate(event);
                    }
                } catch (ex) {
                    log.warn(`Connection ${connection.toString()} failed to handle onStateUpdate:`, ex);
                }
            }
            if (!existingConnections.length) {
                // Is anyone interested in this state?
                const connection = await this.connectionManager.createConnectionForState(roomId, new StateEvent(event));
                if (connection) {
                    log.info(`New connected added to ${roomId}: ${connection.toString()}`);
                    this.connectionManager.push(connection);
                }
            }
            return;
        }

        // We still want to react to our own state events.
        if (event.sender === this.as.botUserId) {
            // It's us
            return;
        }

        for (const connection of this.connectionManager.getAllConnectionsForRoom(roomId)) {
            try {
                if (connection.onEvent) {
                    await connection.onEvent(event);
                }
            } catch (ex) {
                log.warn(`Connection ${connection.toString()} failed to handle onEvent:`, ex);
            }
        }
    }

    private async onQueryRoom(roomAlias: string) {
        log.info("Got room query request:", roomAlias);
        // Determine which type of room it is.
        let res: RegExpExecArray | null;
        res = GitHubIssueConnection.QueryRoomRegex.exec(roomAlias);
        if (res) {
            if (!this.github) {
                throw Error("GitHub is not configured on this bridge");
            }
            try {
                return await GitHubIssueConnection.onQueryRoom(res, {
                    as: this.as,
                    tokenStore: this.tokenStore,
                    messageClient: this.messageClient,
                    commentProcessor: this.commentProcessor,
                    octokit: this.github.octokit,
                });
            } catch (ex) {
                log.error(`Could not handle alias with GitHubIssueConnection`, ex);
                throw ex;
            }
        }

        res = GitHubDiscussionSpace.QueryRoomRegex.exec(roomAlias);
        if (res) {
            if (!this.github) {
                throw Error("GitHub is not configured on this bridge");
            }
            try {
                return await GitHubDiscussionSpace.onQueryRoom(res, {
                    octokit: this.github.octokit,
                    as: this.as,
                });
            } catch (ex) {
                log.error(`Could not handle alias with GitHubRepoConnection`, ex);
                throw ex;
            }
        }

        res = GitHubRepoConnection.QueryRoomRegex.exec(roomAlias);
        if (res) {
            if (!this.github) {
                throw Error("GitHub is not configured on this bridge");
            }
            try {
                return await GitHubRepoConnection.onQueryRoom(res, {
                    as: this.as,
                    tokenStore: this.tokenStore,
                    messageClient: this.messageClient,
                    commentProcessor: this.commentProcessor,
                    octokit: this.github.octokit,
                });
            } catch (ex) {
                log.error(`Could not handle alias with GitHubRepoConnection`, ex);
                throw ex;
            }
        }

        res = GitHubUserSpace.QueryRoomRegex.exec(roomAlias);
        if (res) {
            if (!this.github) {
                throw Error("GitHub is not configured on this bridge");
            }
            try {
                return await GitHubUserSpace.onQueryRoom(res, {
                    octokit: this.github.octokit,
                    as: this.as,
                });
            } catch (ex) {
                log.error(`Could not handle alias with GitHubRepoConnection`, ex);
                throw ex;
            }
        }

        throw Error('No regex matching query pattern');
    }

    private async onAdminRoomSettingsChanged(adminRoom: AdminRoom, settings: AdminAccountData, oldSettings: AdminAccountData) {
        log.debug(`Settings changed for ${adminRoom.userId}`, settings);
        // Make this more efficent.
        if (!oldSettings.github?.notifications?.enabled && settings.github?.notifications?.enabled) {
            log.info(`Notifications enabled for ${adminRoom.userId}`);
            const token = await this.tokenStore.getUserToken("github", adminRoom.userId);
            if (token) {
                log.info(`Notifications enabled for ${adminRoom.userId} and token was found`);
                await this.queue.push<NotificationsEnableEvent>({
                    eventName: "notifications.user.enable",
                    sender: "Bridge",
                    data: {
                        userId: adminRoom.userId,
                        roomId: adminRoom.roomId,
                        token,
                        since: await adminRoom.getNotifSince("github"),
                        filterParticipating: adminRoom.notificationsParticipating("github"),
                        type: "github",
                        instanceUrl: undefined,
                    },
                });
            } else {
                log.warn(`Notifications enabled for ${adminRoom.userId} but no token stored!`);
            }
        } else if (oldSettings.github?.notifications?.enabled && !settings.github?.notifications?.enabled) {
            await this.queue.push<NotificationsDisableEvent>({
                eventName: "notifications.user.disable",
                sender: "Bridge",
                data: {
                    userId: adminRoom.userId,
                    type: "github",
                    instanceUrl: undefined,
                },
            });
        }

        for (const [instanceName, instanceSettings] of Object.entries(settings.gitlab || {})) {
            const instanceUrl = this.config.gitlab?.instances[instanceName].url;
            const token = await this.tokenStore.getUserToken("gitlab", adminRoom.userId, instanceUrl);
            if (token && instanceSettings.notifications.enabled) {
                log.info(`GitLab ${instanceName} notifications enabled for ${adminRoom.userId}`);
                await this.queue.push<NotificationsEnableEvent>({
                    eventName: "notifications.user.enable",
                    sender: "Bridge",
                    data: {
                        userId: adminRoom.userId,
                        roomId: adminRoom.roomId,
                        token,
                        since: await adminRoom.getNotifSince("gitlab", instanceName),
                        filterParticipating: adminRoom.notificationsParticipating("gitlab"),
                        type: "gitlab",
                        instanceUrl,
                    },
                });
            } else if (!instanceSettings.notifications.enabled) {
                log.info(`GitLab ${instanceName} notifications disabled for ${adminRoom.userId}`);
                await this.queue.push<NotificationsDisableEvent>({
                    eventName: "notifications.user.disable",
                    sender: "Bridge",
                    data: {
                        userId: adminRoom.userId,
                        type: "gitlab",
                        instanceUrl,
                    },
                });
            }
        }
        
    }

    private async setupAdminRoom(roomId: string, accountData: AdminAccountData, notifContent: NotificationFilterStateContent) {
        const adminRoom = new AdminRoom(
            roomId, accountData, notifContent, this.as.botIntent, this.tokenStore, this.config,
        );
        adminRoom.on("settings.changed", this.onAdminRoomSettingsChanged.bind(this));
        adminRoom.on("open.project", async (project: ProjectsGetResponseData) => {
            const [connection] = this.connectionManager?.getForGitHubProject(project.id) || [];
            if (!connection) {
                const connection = await GitHubProjectConnection.onOpenProject(project, this.as, adminRoom.userId);
                this.connectionManager?.push(connection);
            } else {
                await this.as.botClient.inviteUser(adminRoom.userId, connection.roomId);
            }
        });
        // adminRoom.on("open.discussion", async (owner: string, repo: string, discussions: Discussion) => {
        //     const connection = await GitHubDiscussionConnection.createDiscussionRoom(
        //         this.as, adminRoom.userId, owner, repo, discussions, this.tokenStore, this.commentProcessor, this.messageClient,
        //     );
        //     this.connections.push(connection);
        // });
        adminRoom.on("open.gitlab-issue", async (issueInfo: GetIssueOpts, res: GetIssueResponse, instanceName: string, instance: GitLabInstance) => {
            const [ connection ] = this.connectionManager?.getConnectionsForGitLabIssue(instance, issueInfo.projects, issueInfo.issue) || [];
            if (connection) {
                return this.as.botClient.inviteUser(adminRoom.userId, connection.roomId);
            } 
            const newConnection = await GitLabIssueConnection.createRoomForIssue(
                instanceName,
                instance,
                res,
                issueInfo.projects,
                this.as,
                this.tokenStore, 
                this.commentProcessor,
                this.messageClient
            );
            this.connectionManager?.push(newConnection);
            return this.as.botClient.inviteUser(adminRoom.userId, newConnection.roomId);
        });
        this.adminRooms.set(roomId, adminRoom);
        if (this.config.widgets?.addToAdminRooms && this.config.widgets.publicUrl) {
            await adminRoom.setupWidget();
        }
        log.info(`Setup ${roomId} as an admin room for ${adminRoom.userId}`);
        return adminRoom;
    }
}
