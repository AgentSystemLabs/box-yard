import type { CaptainMessage, ChatMessage, TaskMessage } from "./types.js"

export type TranscriptMessage = ChatMessage | CaptainMessage | TaskMessage
export interface HistoryDay { at: number; messageId: string }
export interface HistoryPage<M = TranscriptMessage> {
  messages: M[]
  before: string | null
  after: string | null
}
export const HISTORY_PAGE_SIZE = 100
export const HISTORY_WINDOW_SIZE = 200
