# Inline Handwriting for Obsidian

Write by hand directly in your notes, mixed with typed text.

## Install
1. Unzip so you have a folder named `inline-handwriting` containing `main.js`, `manifest.json`, and `styles.css`.
2. Move that folder into `<your vault>/.obsidian/plugins/` (the `.obsidian` folder is hidden; on Windows enable "Hidden items" in File Explorer's View menu).
3. In Obsidian: Settings → Community plugins → reload the list → enable **Inline Handwriting**.
4. Use **Live Preview** mode (the default editing mode). Drawing is off in Source mode.

## How it works
- **Pen draws, mouse types.** Touch your tablet pen to the note and write; use the mouse/keyboard to type as usual.
- **Write on an empty line** (or below the end of the note) → it becomes a handwriting block that takes up space; typed text below moves down.
- **Write beside text** → it becomes a margin note attached to the nearest line, and moves with that line when you add or remove text above it.
- **Write inside an existing block or next to an existing margin note** → the ink is added to it.
- Strokes are saved ~0.7 s after you lift the pen. **Ctrl+Z / Ctrl+Y** (or the toolbar arrows) undo and redo whole bursts of writing.

## Toolbar (bottom-right of each note)
Handwriting mode · Pen · Highlighter · Eraser · Colors · Thin/Medium/Thick · Undo · Redo

- **Handwriting mode** makes the mouse draw too. Use it if your tablet acts like a mouse, then toggle it off to type. Assign a hotkey under Settings → Hotkeys → "Toggle handwriting mode".
- **Eraser** removes whole strokes. The eraser end of a pen also works.
- **Highlighter** draws see-through marks over typed text.

## Drawing tablet tip (Wacom, XP-Pen, Huion)
For "pen draws, mouse types" to work, the tablet must report itself as a pen. In your tablet driver settings, enable **Windows Ink**. Without it the pen acts as a mouse, so use Handwriting mode instead.

## Where the ink is saved
Inside the note itself:
- blocks as ```` ```handwriting ```` code blocks
- margin notes as hidden `%%hw …%%` comments at the end of a line

Everything syncs and moves with the note. In Source mode you'll see the raw data.

## Known limitations (v0.1)
- Margin notes appear in Live Preview but not in Reading view. Blocks show in both.
- Handwriting isn't searchable.
- Margin notes are never attached to headings or table rows. They attach to the nearest normal line instead.
