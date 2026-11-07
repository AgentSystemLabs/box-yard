# Leaving a surface: Back, Close and Esc

Every surface you can open has one way out, which looks and behaves the same everywhere. This page gives the rule,
what it's based on, and where each surface stands. The shared pieces are in `web/src/components/Modal.tsx`:
`DismissButton`, `Modal` and `useModalStep`/`ModalStep`.

## The rule

| Surface | Way out | Where | Also |
| --- | --- | --- | --- |
| **Drill-in** (a task, a Captain or a schedule in the panel over the chat; a thread over the chat on a phone) | **Back** `‹` | top left, before the title | Esc; touch edge swipe on a full-screen phone panel (#264); browser Back for the URL-backed panels |
| **Column** (the chat, and each panel beside it) | **Close** `×`, after Pin, only while another column is in view | top right, the header's end | Esc closes an unpinned panel; browser Back for the URL-backed panels |
| **Interruption** (Settings, dialogs, pickers, previews, confirmations, the sidebar drawer) | **Close** `×` | top right | Esc; backdrop tap unless there are unsaved changes; Cancel in the footer of a form or confirmation |
| **Level inside a surface** (a PR's detail in Pull requests, a task's side questions) | **Back**, named for where it goes ("Back to pull requests", "Back to the task") | replaces that surface's own `×` or Back for as long as it's open | Esc leaves the level first; the next Esc leaves the surface |
| **Menu or popover** | none drawn | — | Esc, a tap outside, a second tap on its button, or picking an item; focus returns to its button. On a touch screen a tall menu leaves room to tap and dims the rest (below) |

- **One way out at the top of any surface, never both Back and ×.** `Modal` draws Back for `placement="panel"` and
  × otherwise. While a `useModalStep` level is open, it draws that level's Back *instead of* the ×.
- **One look.** `DismissButton`: a ChevronLeft (24px) or X (20px) icon with no text, 32px to a mouse and 44px to a
  finger (`pointer-coarse`, not screen width). The accessible name is "Back"/"Close" or more specific, and the tooltip
  adds "(Esc)".
- **Esc closes the topmost layer only.** The Modal stack gives Esc to the newest Modal. Inside it, the newest
  `useModalStep` level goes first. A menu (`usePopover`) lets Esc through while a Modal opened after it is on top, and
  every handler skips an Esc that something nearer already took (`defaultPrevented`).
- **Unsaved work is never lost silently.** `dirty` stops a backdrop tap from closing. Settings asks before it
  discards a draft. The ×, Esc and Cancel go through the surface's own `onClose`, which decides.
- **Focus comes back** to whatever opened the surface (or `returnFocus`), and to a menu's button when the menu closes.
- **A tap outside only closes.** A tap that closes a menu or a dialog never also presses what was under it. A dialog's
  backdrop takes the tap. On a touch screen, the chat switcher draws a dimmed scrim under its menu that does the same.
  The scrim closes on the click, not the press, so the rest of the tap can't fall through.
- **A tall menu leaves room to tap.** On a touch screen, the chat switcher stops at 55% of the window and scrolls
  inside, with its filter pinned at the top. A tap opens it on the current item, not the filter, so the keyboard
  waits until the filter is tapped.

## What it rests on

### From the platform guidelines (source-backed)

- **Back retraces a hierarchy, and Close ends a modal view.** Use the standard buttons, not custom ones, and don't
  label them with text. ([Apple HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars))
  Material's top app bar puts the back arrow at the leading edge.
  ([M3: App bars](https://m3.material.io/components/app-bars/guidelines))
- **An edge swipe is a shortcut for Back, not a replacement.** The Back button stays visible.
  ([Apple HIG: Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures))
  A dragging gesture needs a single-pointer alternative.
  ([WCAG 2.2, 2.5.7 Dragging Movements](https://www.w3.org/TR/WCAG22/#dragging-movements))
- **A modal needs an obvious way out**, and it confirms before losing changes. Dismiss one modal before presenting
  another. ([Apple HIG: Modality](https://developer.apple.com/design/human-interface-guidelines/modality))
- **A sheet shows one control per side.** Back replaces the dismiss control on a sheet's later steps, and you should
  "avoid showing all three". Swipe-to-dismiss asks before discarding unsaved changes.
  ([Apple HIG: Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets))
- **A full-screen dialog's × is the only navigation in its bar.** A basic dialog closes with Cancel, Esc, a tap on the
  scrim or system Back. ([M3: Dialogs](https://m3.material.io/components/dialogs/guidelines))
- **Bottom sheets close by a tap on the scrim, a swipe down or a close control.**
  ([M3: Bottom sheets](https://m3.material.io/components/bottom-sheets/guidelines))
  **Side sheets put Back at the upper left and Close at the upper right.**
  ([M3: Side sheets](https://m3.material.io/components/side-sheets/guidelines))
- **System Back goes to the innermost level first.** The newest registered callback wins.
  ([Android: Predictive back](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture),
  [Custom back navigation](https://developer.android.com/guide/navigation/custom-back))
- **Touch targets:**
  - Apple: 44×44pt ([HIG: Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)).
  - Material: 48dp ([M3: Structure](https://m3.material.io/foundations/designing/structure)).
  - WCAG 2.2: 24px at AA and 44px at AAA
    ([2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum), [2.5.5](https://www.w3.org/TR/WCAG22/#target-size-enhanced)).
- **Esc closes a dialog, and focus moves in on open and back on close.**
  ([WAI-ARIA APG: Modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/))

### Our judgment (where the sources differ or are silent)

- **× is top right.**
  - iOS sheets and M3 full-screen dialogs put Close at the leading edge. M3 side sheets and the web convention put
    it top right.
  - We keep it top right so Back (top left) and Close never share a place, and a Back is never mistaken for a Close.
- **44px to a finger, 32px to a mouse.**
  - That's 44 rather than Material's 48, for the dense task header.
  - Targets switch on pointer type, not screen width, so a narrow desktop window keeps small buttons and a tablet
    gets big ones.
- **A level inside a Modal goes Back in place of the ×** (Apple's sheet rule), and Esc leaves it first (Android's
  innermost-first rule). Neither source covers Esc on the web, so that part is ours.
- **The chat switcher stays a menu under its title on a phone, not a bottom sheet.**
  - It drops from the button that opened it, as Apple's pull-down buttons and M3 menus do.
  - Its filter is at the top, so it stays above the on-screen keyboard. A bottom sheet's filter would sit under the
    keyboard.
  - It adds no second drag gesture beside #264's edge swipe. A tap on the scrim (or the title, which is under it) closes
    it in one move.
  - The 55% cap and the scrim are our numbers. Neither source gives a height for a menu.
- **Forms and confirmations keep × and Cancel.**
  - Cancel is a footer action, not a second way out at the top, so the "never both" rule still holds.
  - It's the button a confirmation's keyboard user expects.
- **The task header's Back is the panel's Back.** A task panel has no Modal title bar, so its header draws the one
  Back. While side questions are open, that Back is named "Back to the task".
- **Beside the chat a panel is a column, not a drill-in.** Its header ends with Pin, and Close (×) beside another
  column, each 44px (`ColumnControls.tsx`), and its Back hides: a task's crumbs (`TreeNav.tsx`) lead up the tree
  instead, or Back to the parent it was opened from. As a sheet over the chat (a phone, a narrow window) it's a
  drill-in again: Back shows and the controls hide. While side questions are open they hide too, so "Back to the task"
  is the header's one way out. Esc leaves a pinned panel where it is beside the chat.
- **Close only beside another column.** The only column in view has no ×, pinned or not: there's nothing to give its
  room to, and the crumbs, the sidebar and Esc lead elsewhere. Beside another, every column has Close, pinned or not,
  though an unpinned one also goes as soon as something else opens. Tying Close to the pin would add it as you pin,
  where Pin was, so a second click to unpin would close the column instead. The chat follows the same rule: a lone
  chat has Pin only.

## Where each surface stands

| Surface | Way out | Esc | Swipe / browser Back |
| --- | --- | --- | --- |
| Task panel | × in the task header while another column is in view (none alone); Back as a sheet | closes, unless pinned beside the chat | edge swipe on a full-screen phone panel; browser Back |
| Task panel, side questions | the same Back, as "Back to the task" (the "‹ Task" line is gone) | back to the transcript, then closes | the swipe still closes the whole panel (see Known gaps) |
| Captain / schedule panel | × in the panel's title bar while another column is in view (none alone); Back as a sheet | closes, unless pinned beside the chat | edge swipe; browser Back |
| The chat beside panels | × in its header (hides it: the panels take the width) | — | picking a chat, or the last panel closing, shows it |
| Thread over the chat (phone) / beside it (wide) | Back "Back to the chat" / × "Close thread" (one at a time) | closes | — |
| Settings | × top right (and a footer Close) | closes, asking first about unsaved changes | no history entry of its own (`?settings=` replaces) |
| Settings › nested dialogs, project settings | × top right, Cancel in the footer | topmost only | — |
| Pull requests | × on the list; Back "Back to pull requests" on a PR's detail | detail → list → closed | — |
| Files drawer | × | clears the filter first, then closes | backdrop tap |
| File preview | × "Close" | closes | browser Back (`?preview=`) |
| Image viewer | × "Close" | closes | backdrop tap |
| Task details (ⓘ) / where it runs | × | closes; focus back to the title or chip | backdrop tap, sheet on a phone |
| Captain actions (a Captain's ⋯) | × | closes; focus back to ⋯ (and from Project settings or Compaction history it opens) | backdrop tap, sheet on a phone |
| Confirmations | ×, Cancel | answers "no" | — |
| Search (command palette) | × on a phone; an "esc" hint on wider screens | closes | backdrop tap |
| Sidebar drawer (phone) | × "Close the sidebar" | closes | backdrop tap |
| Chat switcher ("Coordinator ⌄", a Captain's title) | — | closes the menu only | a second tap on the title; on a touch screen, a tap on the dimmed scrim (the title is under it); with a mouse, a click outside |
| Other menus (`usePopover`: merge, Boxes ⋯) | — | closes the menu only, unless a dialog is on top | tap outside |

### Exceptions, on purpose

- **Settings keeps a footer Close and its in-page "‹ Box providers" link.**
  - It's a split view: the link moves within the page, it doesn't leave it.
  - Folding the footer into the × is a separate Settings change.
- **The run-target picker (`RunTargetMenu`) has its own Esc** and is owned by the picker work. It already stops Esc
  from reaching the surface under it.

### Known gaps

- **On a phone, the panel's edge swipe closes the task even while side questions show**, where Esc and Back return to
  the transcript first. Making the swipe pop a level means the gesture has to put the panel back after the pop (it
  stays mounted). That's left to the gesture's owner (#264).
- **The small menus (merge, Boxes ⋯) have no scrim yet.** On a touch screen, a tap outside one closes it and
  also lands on what's underneath. They open inside their header, not over the page, so a scrim for them needs its own
  portal. That's a follow-up.
- **Toasts, the dictation bar and the voice bar are status strips, not surfaces.** Each keeps its own dismiss, not
  `DismissButton`. Every toast's is a ✕ top right, after any action (Undo): a 44px target drawn as a 32px chip, named
  "Dismiss". It only dismisses, never runs the action or opens the task (`DismissToast` in `Toasts.tsx`).
