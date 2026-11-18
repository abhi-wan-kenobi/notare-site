## 2026-11-14

- Replaced the mockup-based homepage with a 0.7.1 product tour and ten real app screenshots using fictional data.
- Added responsive layouts, a keyboard-accessible FAQ, a skip link, and a product social-sharing image.
- Corrected Windows signing, Linux updates, optional remote processing, and sync-preview disclosures; removed unsupported performance claims.
- Updated privacy information for calendar writes, Gmail drafts, Outlook, AI context, peer sync, and MCP access.
- Disclosed Cloudflare's existing, edge-injected Web Analytics separately from the desktop app's no-telemetry policy.

## Earlier changes

- src/layouts/Base.astro: Updated favicon, brand logo, social image, and stripped personal links/credits from the footer.
- src/styles/global.css: Redesigned dark-first color scheme, added glow animations, transitions, and screenshot window framing styles.
- src/pages/index.astro: Redesigned layout with updated tone, new GPU Server and Visual Tour sections, and signed installer notes.
- src/pages/plus.astro: Replaced active waitlist form and Javascript logic with a disabled "Waitlist opening soon" state.
