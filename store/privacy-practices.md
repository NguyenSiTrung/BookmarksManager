# Chrome Web Store "Privacy practices" — draft answers

> **Draft — release prerequisite.** These are the answers to give in the
> Chrome Web Store developer dashboard's privacy tab at submission time.
> Google sets the checkbox labels and they can change: map this inventory to
> the current labels then. Keep this file in the same change as any code that
> alters data flow — a mismatch between dashboard answers, the privacy policy,
> and actual behavior can suspend all of the publisher's items.
>
> This version describes the **current slice only**: the extension foundation
> plus a consented, synthetic Jev test-connection flow. Bookmark management
> features are not in this release and are not declared here.

## Single purpose

> Manage and review your Chrome bookmarks from the side panel. In this
> release the extension provides its bookmark-manager surfaces and an
> optional connection test for an AI provider you configure with your own
> API key. The test sends only synthetic data — never your bookmarks.

## Permission justifications

Use the justification column of `store/permissions.md` verbatim; CI
(`npm run check:manifest`) keeps that table equal to the generated manifest.

- `storage` — store extension settings and consent records locally on the
  device.
- `sidePanel` — show the Bookmarks Manager UI in Chrome's side panel.
- `https://api.typesafe.ai/*` (optional) — Jev test connection to TypeSafe,
  started by the user.
- `https://openrouter.ai/*` (optional) — Jev test connection to OpenRouter,
  started by the user.

## Remote code

**No, the extension does not use remote code.** All JavaScript and HTML are
bundled at build time by WXT; `npm run check:bundle` scans the emitted bundle
for `eval(`, `new Function`, and remote `<script src>` tags and fails the
build on any hit.

## Data usage

Conservative declaration — under-declaring is the risky direction:

- **Authentication information: yes.** The user's own API key is stored
  encrypted on the device and sent only to the provider that issued it, in
  the `Authorization` header, when the user runs a Test connection.
- **Everything else: not collected in this release.** The only other
  transmission is the test connection's fixed synthetic payload, which
  contains no user data.
- Not collected: personally identifiable information, health information,
  financial and payment information, personal communications, location, web
  history, user activity, website content. (No click or keystroke monitoring;
  no bookmark or page content leaves the device in this release.)

Before any future feature sends bookmark, page, or activity data, update this
declaration, `store/privacy-policy.md`, and the in-product consent screen in
the same change.

## Certifications (Limited Use)

Tick all three:

- Data is not sold to third parties.
- Data is not used or transferred for purposes unrelated to the extension's
  single purpose.
- Data is not used or transferred to determine creditworthiness or for
  lending purposes.

## Privacy policy URL

_release prerequisite — the hosted URL from `store/privacy-policy.md` once
the policy is published._
