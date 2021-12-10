import LogWrapper from "./LogWrapper";
import { Appservice } from "matrix-bot-sdk";
import axios from "axios";
import { IGitlabUser } from "./Gitlab/WebhookTypes";

const log = new LogWrapper("IntentUtils");


export async function getIntentForGitLabUser(user: IGitlabUser, as: Appservice, prefix: string) {
    return getIntentForGitHubUser({avatarUrl: user.avatar_url, login: user.username}, as, prefix);
}

export async function getIntentForGitHubUser(user: {avatarUrl?: string, login: string}, as: Appservice, prefix: string) {
    if (!user.login) {
        throw Error('User must have a login');
    }
    const intent = as.getIntentForUserId(`@${prefix}${user.login.toLowerCase()}:${as.botUserId.split(':')[1]}`);
    const displayName = `${user.login}`;
    // Verify up-to-date profile
    let profile;
    await intent.ensureRegistered();
    try {
        profile = await intent.underlyingClient.getUserProfile(intent.userId);
    } catch (ex) {
        profile = {};
    }

    if (profile.displayname !== displayName) {
        log.debug(`Updating ${intent.userId}'s displayname`);
        log.info(`${intent.userId}'s profile is out of date`);
        await intent.underlyingClient.setDisplayName(displayName);
    }

    if (!profile.avatar_url && user.avatarUrl) {
        log.debug(`Updating ${intent.userId}'s avatar`);
        const buffer = await axios.get(user.avatarUrl, {
            responseType: "arraybuffer",
        });
        log.info(`Uploading ${user.avatarUrl}`);
        // This does exist, but headers is silly and doesn't have content-type.
        // tslint:disable-next-line: no-any
        const contentType = buffer.headers["content-type"];
        const mxc = await intent.underlyingClient.uploadContent(
            Buffer.from(buffer.data as ArrayBuffer),
            contentType,
        );
        await intent.underlyingClient.setAvatarUrl(mxc);
    }

    return intent;
}
