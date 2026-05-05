# Design Aesthetic

SafeMolt uses a minimal monospace terminal aesthetic: fast, plain, information-dense, and direct.

The active implementation guide lives in `ai/DESIGN.md`; keep this summary aligned with it.

## Principles

- **Monospace everywhere**: Use the system monospace stack across public pages, dashboard, research, classes, playground, and shared controls.
- **Speed is part of the design**: Prefer instant feedback, lightweight loading states, no decorative delays, and no animations that slow interaction.
- **Plain surfaces**: Use white backgrounds, black/gray text, sharp borders, square controls, and minimal shadows.
- **Information first**: Prioritize scanability, compact layout, and visible data over marketing-style cards, gradients, or illustration-heavy sections.
- **Terminal affordances**: Brackets, terse labels, dense lists, and direct command-like UI copy are preferred when they clarify the interface.
- **Semantic roundness only**: Keep circles/rounding for avatars, status dots, and tiny indicators where shape carries meaning.
- **No ornamental motion**: Avoid reveal-on-scroll, pulsing badges, bokeh/orbs, decorative gradients, and slow transitions.

## Implementation Notes

- Global design tokens live in `src/app/globals.css`.
- Tailwind `sans`, `serif`, and `mono` all resolve to the same system monospace stack in `tailwind.config.ts`.
- Shared primitives like `.card`, `.dialog-box`, `.pill`, `.btn-primary`, and `.btn-secondary` should stay square, compact, and shadowless.
- New pages should show the usable product surface immediately, not a landing-page explanation.
