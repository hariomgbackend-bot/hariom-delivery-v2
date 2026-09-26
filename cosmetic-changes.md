# Cosmetic Changes — Visual Polish Ideas

## Quick Wins (1–2 files, big visual pop)

### Skeleton loaders
Replace all "Loading…" text and spinner spinners with shimmer skeleton cards/rows.
- Files: admin.html, accountant.html, service.html, staff.html, driver_interface.html
- Approach: CSS-only shimmer animation on placeholder divs matching card/row dimensions
- Effort: ~30 lines CSS shared, update each render function

### Toast upgrade
Current toasts are plain text. Add colored icons (✅ success, ⚠️ error, ℹ️ info) with slide-in animation.
- File: service.html (showToast), then port to other pages
- Approach: add icon + color class param to showToast()

### Card stagger animation
When lists render, cards fade in one by one with a tiny delay (20ms apart).
- Files: all list render functions (renderMobileCards, renderTicketsMob, etc.)
- Approach: set animation-delay inline via style, CSS `@keyframes cardIn { from { opacity:0; transform:translateY(8px) } }`

### Empty states
Replace "No tickets found" / "No deliveries" text with simple inline SVG illustrations.
- Files: all render functions that have empty-state text
- Approach: inline simple SVGs (box, clipboard, etc.) with a short message

---

## Medium Effort (spans more files)

### Animated page/panel transitions
When switching tabs (admin sidebar views, filter toggles), a subtle `opacity 0.15 + translateY(-4px)` entrance.
- Files: admin.html (tab switching), accountant.html (view switching)
- Approach: add a CSS class `.panel-enter` that triggers animation on mount

### Hover glow on cards
Subtle `box-shadow` with the store's gradient color on hover (cards currently lift but don't glow).
- Files: all card CSS blocks
- Approach: add `box-shadow: 0 4px 20px rgba(...)` on hover using CSS variables

### Live status dot pulse
Small pulsing dot next to "pending"/"loaded"/"new" status badges to draw attention.
- Files: all badge rendering blocks
- Approach: `::before` pseudo-element with `@keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }`

### Welcome overlay refresh
Animated gradient background, slight parallax, smoother entrance.
- Files: accountant.html, admin.html (the welcome overlay)
- Approach: CSS `@keyframes gradientShift` on the overlay background

---

## Big Refactor (high effort)

### Extract shared CSS
Unify all ~7,545 lines of duplicated CSS across 15 HTML pages into one `design-system.css`.
- Zero visual change
- Eliminates inconsistency between `.btn-teal` (service) vs `.btn-success` (accountant) etc.
- Makes future styling changes trivial
- Risk: thorough testing required to not miss page-specific overrides

---

## Design Tokens to Consider Standardizing

Missing CSS custom properties that would make future theming easier:
- `--space-xs` / `--space-sm` / `--space-md` / `--space-lg` (spacing scale)
- `--radius-sm` / `--radius-md` / `--radius-lg` / `--radius-xl` (border-radius scale)
- `--font-xs` / `--font-sm` / `--font-md` / `--font-lg` (font-size scale)
- `--focus-ring` (shared focus outline style)
- `--transition-fast` / `--transition-normal` (shared transition durations)
