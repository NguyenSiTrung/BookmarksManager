# Generative AI — developer dashboard disclosure answers

> Paste-ready answers for the Chrome Web Store dashboard's AI-feature
> disclosure questions (Developer Dashboard → item → **Privacy practices** /
> **Store listing**). The dashboard wording varies slightly over time; these
> answers cover each question the flow can ask. Every statement is checkable
> against `store/privacy-policy.md`, `store/privacy-practices.md`, and the
> shipped behavior.

## Does your item use AI?

**Yes.**

## Describe the AI features in your item

Bookmarks Manager is a local-first bookmark organizer. All core features —
save, search, tags, notes, duplicates, import/export — run entirely on the
device and never call a model.

The item includes optional, off-by-default generative AI features that the
user must set up with their own API key before anything can be sent:

1. **Jev provider decisions** (providers: TypeSafe, OpenRouter, or a custom
   System One-compatible endpoint the user configures): bookmark
   categorization, tag suggestions, folder pre-selection, near-duplicate
   checks, misfiled-bookmark scans, and re-ranking of an "Ask" search. Sends
   bookmark metadata only (title, cleaned URL, domain, folder path, tag names
   and descriptions, candidate folder paths, candidate bookmarks, the
   near-duplicate partner, and the Ask query) and only on a user-started
   action. Bookmark notes are never sent.
2. **OpenAI-compatible LLM provider** (presets OpenAI/OpenRouter, or a custom
   HTTPS endpoint the user configures): plain-language explanations of review
   decisions, budget-capped second opinions on low-confidence calls,
   folder-restructure proposals that are never applied automatically, and
   opt-in page summaries verified by Jev. Page summaries send the page title,
   cleaned URL, headings, a bounded page excerpt, and site name/meta
   description when present.

Both flows require: an explicit per-feature consent with the recipient and
sent-field list shown before any send, the browser's host-permission grant,
an encrypted on-device API key, a monthly spending budget the user sets, and
revoke-at-any-time control that removes the grant, the host permission, and
the key. No AI request is made on install, on a timer, or in the background.

## What data does the AI process, and where is it sent?

Data is sent only to the provider the user configures and authenticates with
their own key (TypeSafe, OpenRouter, or a custom endpoint). No developer
server exists in the data path; the extension makes no AI requests to any
developer-operated service. URL query strings, fragments, and embedded
credentials are stripped before sending. Full field lists per feature are in
`store/privacy-practices.md` and in the in-product consent disclosures.

## Does your item let users generate content?

Yes — but only for the user's own private use: model output (suggested tags,
categories, explanations, summaries, restructure proposals) is written into
the user's own local bookmark metadata and shown in the extension UI.

## Is any AI-generated content publicly visible or shared with other users?

**No.** The item has no accounts, no server, no sharing, no comments, and no
public surface. All generated output stays in the user's local extension
storage and their own browser bookmark library.

## Does your item allow users to communicate with or interact with AI?

Yes. Users can run an "Ask" search (a re-ranked bookmark query), request
explanations of review decisions, request second opinions, request
folder-restructure proposals, and request page summaries. Each is a
user-initiated request to their configured provider; there is no open-ended
chat with a developer-hosted model.

## User-generated content and moderation

Not applicable in the policy sense: no user-generated content is published or
visible to other users, so no moderation surface exists. Nothing the user or
the model produces leaves the device except the request/response with the
user's own provider.

## Screenshot / listing cross-check

- Listing copy: `store/listing.md` ("There is also an optional, off-by-default
  AI connection…").
- Screenshot `store/assets/screenshot-options-ai-1280x800.png` shows the
  in-product provider disclosure (recipients, fields sent, fields never sent)
  users must read before enabling anything.
- Privacy policy: `store/privacy-policy.md` (hosted at the release privacy
  URL).
