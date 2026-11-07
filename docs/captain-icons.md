# Captain icons

Every project's Captain shows an icon wherever the Captain itself shows: the sidebar's Captain row, its chat header and
composer, the Coordinator's cards and update chips, notices, a task's "Send to Captain", and the project's Captain tab.
The default is the **Captain's cap**. The Coordinator always shows the **ship's helm**. Both are Box Yard's own
drawings (`web/src/components/ShipIcons.tsx`), made on lucide's 24px grid with its 2px stroke.

## Which icon a Captain shows

`captainMark` in `shared/captainMark.ts` decides, in this order:

1. The project's own pick (Project settings › General › Captain icon).
2. With **Use default** (no pick): the project's uploaded image, if it has one.
3. Settings › Coordinator › Captain icon, which sets every Captain's icon.
4. The Captain's cap.

Places that show the project rather than its Captain (its dot, the project list, task tiles) keep the project's image,
as before. The project's picker says which icon its Captain shows as the form stands, and why.

## Where it's stored

Both settings hold an icon **id** from the catalogue (`captain-cap`, `anchor`, `crown` and so on), never markup:

- the global one is the `captainIcon` setting (`PUT /api/agent-settings`);
- a project's is `projects.captain_icon`, null for Use default (`PATCH /api/projects/:id` `captainIcon`, and
  `update_project`'s `captain_icon` for the Coordinator).

The server refuses an id that isn't in the catalogue. A saved id this build doesn't know (an icon since taken out)
reads as no pick: Use default for a project, the cap for Settings.
Like the rest of Settings and project settings, a pick is a draft until Save.

## The catalogue

`shared/captainIcons.ts` lists the picker's icons by group, each as `[id, more search words, label?]`. The label
defaults to the id in words. `web/src/lib/captainIconCatalog.ts` maps each id to its component. To add an icon, add it
to a group and to the map: `test/captain-icons.test.ts` fails if the two differ. A lucide icon's id is its canonical
name (`lucide.dev/icons/<id>`), not an alias.

The first screen carries only the cap, the helm and the bot. The catalogue's names and components load when the picker
opens, or when a Captain shows an icon that isn't built in. Until then, that icon's place stays empty at its size, so
no other icon flashes first. `test/bundle-split.test.ts` keeps it that way.

## The picker

`web/src/components/CaptainIconPicker.tsx` opens in place rather than as a dialog over the settings dialog. It holds a
search, then every icon by group as one radio group of 44px tiles. Each search word must start one of an icon's words,
so "sh wh" finds Ship wheel. Arrow keys move through the icons and pick as they go (↑/↓ go by row), and Home/End jump to
the ends. Esc clears the search, then closes the picker, before the dialog around it.

## Licence

The catalogue's icons other than the cap and the helm are [Lucide](https://lucide.dev)'s, under the ISC licence. A few
of them come from Feather and are under MIT. Both licences are in [`licenses/lucide.txt`](../licenses/lucide.txt), and
both are compatible with this repository's MIT licence.
