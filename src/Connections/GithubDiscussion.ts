import { IConnection } from "./IConnection";
import { Appservice } from "matrix-bot-sdk";
import { UserTokenStore } from "../UserTokenStore";
import { CommentProcessor } from "../CommentProcessor";
import { MessageSenderClient } from "../MatrixSender";
import { getIntentForGitHubUser } from "../IntentUtils";
import { MatrixEvent, MatrixMessageContent } from "../MatrixEvent";
import { Discussion } from "@octokit/webhooks-types";
import emoji from "node-emoji";
import markdown from "markdown-it";
import { DiscussionCommentCreatedEvent } from "@octokit/webhooks-types";
import { GithubGraphQLClient } from "../Github/GithubInstance";
import LogWrapper from "../LogWrapper";
import { BaseConnection } from "./BaseConnection";
import { BridgeConfigGitHub } from "../Config/Config";
import { config } from "winston";
export interface GitHubDiscussionConnectionState {
    owner: string;
    repo: string;
    id: number;
    internalId: string;
    discussion: number;
    category: number;
}

const log = new LogWrapper("GitHubDiscussion");
const md = new markdown();

/**
 * Handles rooms connected to a github repo.
 */
export class GitHubDiscussionConnection extends BaseConnection implements IConnection {
    static readonly CanonicalEventType = "uk.half-shot.matrix-hookshot.github.discussion";
    static readonly LegacyCanonicalEventType = "uk.half-shot.matrix-github.discussion";

    static readonly EventTypes = [
        GitHubDiscussionConnection.CanonicalEventType,
        GitHubDiscussionConnection.LegacyCanonicalEventType,
    ];

    static readonly QueryRoomRegex = /#github_disc_(.+)_(.+)_(\d+):.*/;

    readonly sentEvents = new Set<string>(); //TODO: Set some reasonable limits

    public static async createDiscussionRoom(
        as: Appservice, userId: string|null, owner: string, repo: string, discussion: Discussion,
        tokenStore: UserTokenStore, commentProcessor: CommentProcessor, messageClient: MessageSenderClient,
        githubConfig: BridgeConfigGitHub,
    ) {
        const commentIntent = await getIntentForGitHubUser({
            login: discussion.user.login,
            avatarUrl: discussion.user.avatar_url,
        }, as, githubConfig.userIdPrefix);
        const state: GitHubDiscussionConnectionState = {
            owner,
            repo,
            id: discussion.id,
            internalId: discussion.node_id,
            discussion: discussion.number,
            category: discussion.category.id,
        };
        const invite = [as.botUserId];
        if (userId) {
            invite.push(userId);
        }
        const roomId = await commentIntent.underlyingClient.createRoom({
            invite,
            preset: 'public_chat',
            name: `${discussion.title} (${owner}/${repo})`,
            topic: emoji.emojify(`Under ${discussion.category.emoji} ${discussion.category.name}`),
            room_alias_name: `github_disc_${owner.toLowerCase()}_${repo.toLowerCase()}_${discussion.number}`,
            initial_state: [{
                content: state,
                state_key: '',
                type: GitHubDiscussionConnection.CanonicalEventType,
            }],
        });
        await commentIntent.sendEvent(roomId, {
            msgtype: 'm.text',
            body: discussion.body,
            formatted_body: md.render(discussion.body),
            format: 'org.matrix.custom.html',
        });
        await as.botIntent.ensureJoined(roomId);
        return new GitHubDiscussionConnection(roomId, as, state, '', tokenStore, commentProcessor, messageClient, githubConfig);
    }

    constructor(roomId: string,
        private readonly as: Appservice,
        private state: GitHubDiscussionConnectionState,
        stateKey: string,
        private tokenStore: UserTokenStore,
        private commentProcessor: CommentProcessor,
        private messageClient: MessageSenderClient,
        private config: BridgeConfigGitHub) {
            super(roomId, stateKey, GitHubDiscussionConnection.CanonicalEventType);
        }

    public isInterestedInStateEvent(eventType: string, stateKey: string) {
        return GitHubDiscussionConnection.EventTypes.includes(eventType) && this.stateKey === stateKey;
    }

    public async onMessageEvent(ev: MatrixEvent<MatrixMessageContent>) {
        const octokit = await this.tokenStore.getOctokitForUser(ev.sender);
        if (octokit === null) {
            // TODO: Use Reply - Also mention user.
            await this.as.botClient.sendNotice(this.roomId, `${ev.sender}: Cannot send comment, you are not logged into GitHub`);
            return true;
        }
        const qlClient = new GithubGraphQLClient(octokit);
        const commentId = await qlClient.addDiscussionComment(this.state.internalId, ev.content.body);
        log.info(`Sent ${commentId} for ${ev.event_id} (${ev.sender})`);
        this.sentEvents.add(commentId);
        return true;
    }

    public get discussionNumber() {
        return this.state.discussion;
    }

    public get repo() {
        return this.state.repo.toLowerCase();
    }

    public get owner() {
        return this.state.owner.toLowerCase();
    }

    public toString() {
        return `GitHubDiscussion ${this.owner}/${this.repo}#${this.state.discussion}`;
    }

    public async onDiscussionCommentCreated(data: DiscussionCommentCreatedEvent) {
        if (this.sentEvents.has(data.comment.node_id)) {
            return;
        }
        const intent = await getIntentForGitHubUser(data.comment.user, this.as, this.config.userIdPrefix);
        await this.messageClient.sendMatrixMessage(this.roomId, {
            body: data.comment.body,
            formatted_body: md.render(data.comment.body),
            msgtype: 'm.text',
            external_url: data.comment.html_url,
            'uk.half-shot.matrix-hookshot.github.discussion.comment_id': data.comment.id,
        }, 'm.room.message', intent.userId);
    }
}
