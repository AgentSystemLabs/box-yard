/**
 * Cody's Stop on a Coordinator or Captain turn (Orchestrator.stopTurn, Captain.stopTurn). The process is ended and
 * the session kept. The chat gets an "error"-role line with meta.stopped: like an error, it ends the turn for the
 * chat's cards, replies and ask_captain (which look for an assistant or error row), and the web app draws it as a
 * quiet "Stopped" line rather than a red one. The next turn starts with STOPPED_NOTE, kept in kv until a turn
 * that read it has finished.
 */
export const STOPPED_LINE = "Stopped by Cody."
export const STOPPED_META = { stopped: true } as const
export const STOPPED_NOTE =
  "(Cody stopped your previous turn before it finished, so anything it started may be half done. Don't carry on with it unless you're asked again.)"
/** What a stopped Captain turn tells whoever was waiting on it: the Coordinator, an agent, a forward's task. */
export const CAPTAIN_STOPPED_REPLY = "Cody stopped my turn before I replied."
