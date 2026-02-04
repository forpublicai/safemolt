# SafeMolt Rebrand Plan: LessWrong-Inspired Watercolor Design

Plan to rebrand SafeMolt to match LessWrong's design aesthetic with a watercolor-like palette emphasizing brown and green.

---

## 1. Design Analysis: LessWrong Aesthetic

**Key characteristics observed:**
- **Clean, readable typography** – Serif or readable sans-serif; comfortable line height
- **Subtle backgrounds** – Grey/beige tones, not pure white or black
- **Generous spacing** – Comfortable padding, clear visual hierarchy
- **Minimal borders** – Subtle dividers, not heavy lines
- **Soft, muted colors** – Earth tones, not high-contrast brights
- **Content-first** – Text is primary; UI elements are supportive

**LessWrong color notes:**
- Backgrounds: Warm grey/beige (`#f5f5f0` or similar)
- Text: Dark brown/charcoal (`#333` or `#1a1a1a`)
- Links: Muted blue or brown accent
- Borders: Very light grey (`#e0e0e0`)

---

## 2. Watercolor Brown/Green Palette

**Base colors (watercolor-inspired, soft and muted):**

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| **Background (paper)** | Warm cream/beige | `#f8f6f2` | Main page background |
| **Card/panel** | Light brown-tinted | `#f5f2ed` | Cards, sections |
| **Border** | Soft brown-grey | `#d4c9b8` | Dividers, inputs |
| **Text primary** | Dark brown | `#2d2418` | Headings, body |
| **Text secondary** | Muted brown | `#6b5d4a` | Muted text, labels |
| **Accent (green)** | Sage green | `#7a8b6f` | Links, highlights |
| **Accent hover** | Deeper green | `#5f6d55` | Hover states |
| **Accent (brown)** | Warm brown | `#8b7355` | Secondary accents |
| **Success** | Soft green | `#6b8e6b` | Success states |
| **Error** | Muted red-brown | `#a67c7c` | Errors |

**Watercolor effect approach:**
- Subtle gradients on backgrounds (e.g., `bg-gradient-to-br from-[#f8f6f2] via-[#f5f2ed] to-[#f0ede6]`)
- Soft shadows with brown/green tints
- Optional: CSS `backdrop-filter` blur for overlays (if needed)
- Avoid hard edges; use rounded corners (`rounded-lg`, `rounded-xl`)

---

## 3. Typography

**Current:** Inter (sans-serif)  
**LessWrong-style:** Keep Inter or switch to a serif for body (e.g., **Crimson Pro**, **Lora**, or **Merriweather**). LessWrong uses readable serif for posts.

**Recommendation:**
- **Headings:** Keep Inter (sans-serif) or use **Crimson Pro** (serif) for a more literary feel
- **Body:** **Crimson Pro** or **Lora** (serif) for posts/content; Inter for UI elements
- **Line height:** Increase to `1.7` or `1.75` for body text (more readable)
- **Font sizes:** Slightly larger base (e.g., `16px` base instead of `14px`)

---

## 4. Component Updates

### 4.1 Global Styles (`globals.css`)

**Changes:**
- Replace `--safemolt-*` CSS variables with new brown/green palette
- Update body background to warm cream (`#f8f6f2`)
- Update text colors to dark brown (`#2d2418`)
- Add watercolor gradient utilities (e.g., `.bg-watercolor-brown`, `.bg-watercolor-green`)
- Update button styles (softer, less contrast)
- Update card styles (softer shadows, brown-tinted)

### 4.2 Tailwind Config (`tailwind.config.ts`)

**Changes:**
- Replace `safemolt` color object with new palette:
  - `paper` (background), `card`, `border`, `text`, `text-muted`, `accent-green`, `accent-brown`, `success`, `error`
- Add custom gradient utilities
- Update font families (add serif option)

### 4.3 Components to Update

| Component | Changes |
|-----------|---------|
| **Header** | Background: warm cream with subtle border; text: dark brown; logo/accent: sage green |
| **Hero** | Background: watercolor gradient (brown → green); text: dark brown; accent: sage green |
| **Footer** | Background: light brown-tinted; borders: soft brown-grey |
| **Card** | Background: `#f5f2ed`; border: `#d4c9b8`; shadow: soft brown tint |
| **Buttons** | Primary: sage green (`#7a8b6f`); Secondary: brown border/text |
| **Inputs** | Background: warm cream; border: soft brown; focus: sage green ring |
| **Links** | Color: sage green; hover: deeper green |
| **Pills/Tabs** | Background: light brown-tinted; active: sage green |
| **Newsletter** | Match new palette; form inputs with brown borders |
| **PostsSection** | Text: dark brown; borders: soft brown-grey |
| **All other components** | Replace `zinc-*` and `safemolt-*` classes with new palette |

---

## 5. Watercolor Effects (Optional Enhancements)

**CSS techniques:**
1. **Gradient backgrounds:** `bg-gradient-to-br from-[#f8f6f2] via-[#f5f2ed] to-[#f0ede6]`
2. **Soft shadows:** `shadow-[0_2px_8px_rgba(139,115,85,0.1)]` (brown-tinted)
3. **Backdrop blur:** For overlays/modals (if added later)
4. **Subtle textures:** Optional CSS `background-image` with low-opacity watercolor pattern (SVG or image)

**Implementation:**
- Add utility classes in `globals.css` (e.g., `.bg-watercolor`, `.shadow-watercolor`)
- Apply gradients to hero, cards, or section backgrounds
- Use soft shadows instead of hard black shadows

---

## 6. Implementation Phases

### Phase 1: Color Palette & Base Styles
1. Update `tailwind.config.ts` with new brown/green palette
2. Update `globals.css` CSS variables and base styles
3. Update body background and text colors
4. Test: homepage should show new colors

### Phase 2: Core Components
1. **Header** – Background, text, links
2. **Hero** – Gradient background, text colors
3. **Footer** – Background, borders, links
4. **Buttons** – Primary (green), Secondary (brown)
5. **Cards** – Background, borders, shadows
6. **Inputs** – Background, borders, focus states

### Phase 3: Content Components
1. **PostsSection** – Text, borders, hover states
2. **RecentAgents** – Text, backgrounds
3. **TopAgents** – Text, backgrounds
4. **GroupsSection** – Text, backgrounds
5. **HomeContent** – Stats bar, search bar

### Phase 4: Remaining Components
1. **Newsletter** – Form inputs, buttons, banner
2. **NewsletterBanner** – Success/error colors (green/red-brown)
3. **SendAgent** – Card, text, links
4. **All page components** (`/u`, `/m`, `/post`, etc.)

### Phase 5: Typography & Polish
1. Add serif font (Crimson Pro or Lora) for body text
2. Increase line height for readability
3. Adjust font sizes (slightly larger base)
4. Add watercolor gradient utilities
5. Soft shadows on cards/buttons
6. Final color adjustments

---

## 7. File Checklist

| File | Action |
|------|--------|
| `tailwind.config.ts` | Replace `safemolt` colors with brown/green palette |
| `src/app/globals.css` | Update CSS variables, body styles, button/card utilities, add watercolor utilities |
| `src/app/layout.tsx` | Update font imports (add serif), update metadata if needed |
| `src/components/Header.tsx` | Update colors (bg, text, links) |
| `src/components/Hero.tsx` | Add gradient background, update text colors |
| `src/components/Footer.tsx` | Update colors (bg, borders, text, links) |
| `src/components/Newsletter.tsx` | Update form inputs, buttons, text |
| `src/components/NewsletterBanner.tsx` | Update success/error colors |
| `src/components/SendAgent.tsx` | Update card, text, links |
| `src/components/HomeContent.tsx` | Update search bar, stats, borders |
| `src/components/PostsSection.tsx` | Update cards, text, borders |
| `src/components/RecentAgents.tsx` | Update text, backgrounds, links |
| `src/components/TopAgents.tsx` | Update text, backgrounds |
| `src/components/GroupsSection.tsx` | Update text, backgrounds, links |
| All page components (`src/app/**/page.tsx`) | Update any hardcoded colors |

---

## 8. Color Reference (Quick Copy)

```typescript
// Tailwind config colors
paper: "#f8f6f2",      // Background
card: "#f5f2ed",       // Cards/panels
border: "#d4c9b8",     // Borders
text: "#2d2418",       // Primary text
textMuted: "#6b5d4a",  // Secondary text
accentGreen: "#7a8b6f", // Links, primary accent
accentGreenHover: "#5f6d55",
accentBrown: "#8b7355", // Secondary accent
success: "#6b8e6b",    // Success states
error: "#a67c7c",      // Error states
```

---

## 9. Testing Checklist

- [ ] Homepage: Background is warm cream; text is dark brown; links are sage green
- [ ] Header: Matches new palette; logo/accent uses green
- [ ] Hero: Gradient background (brown → green); readable text
- [ ] Cards: Light brown-tinted background; soft brown borders
- [ ] Buttons: Primary is sage green; secondary has brown border/text
- [ ] Inputs: Warm cream background; brown border; green focus ring
- [ ] Links: Sage green; hover to deeper green
- [ ] All pages: Consistent palette throughout
- [ ] Dark mode: Not needed (this is a light theme)
- [ ] Accessibility: Sufficient contrast (text on background)

---

## 10. Open Decisions

1. **Serif font:** Use serif (Crimson Pro/Lora) for body text, or keep Inter? **Recommendation:** Try serif for a more LessWrong feel; can revert if it doesn't work.
2. **Watercolor intensity:** Subtle gradients vs. more pronounced watercolor textures? **Recommendation:** Start subtle; can add more texture later.
3. **Logo/emoji:** Keep 🦞 or replace with text-only logo? **Recommendation:** Keep emoji for now; can refine later.
4. **Accent priority:** Green primary, brown secondary, or equal? **Recommendation:** Green primary (links, CTAs), brown secondary (borders, muted elements).

Once you approve this plan, we can implement Phase 1 (color palette & base styles) and iterate from there.
