# Batch 57: Classic is unchanged

Every Classic screen in the Batch 57 set, shot with Aiden Workspace off on
`main` (a747bc1, dev server on 5301) and on this branch (dev server on 5199),
same fake backend, same viewport, then compared pixel by pixel
(`scripts/ui-shots/shoot.mjs --set b57 --design classic`).

Result: 29 identical. The 15 others differ only where the fake data reads the
clock (the two runs were a few minutes apart): message times in a chat, a
campaign's timeline times, and the frame Classic's pulsing "Today" dot was
caught at. Crops of each kind, main on the left, branch on the right:

- `diff-inbox-chat-mobile-timestamps.png`
- `diff-campaign-results-timestamps.png`
- `diff-home-live-dot.png`

Not compared here: Classic's campaign wizard and contact drawer (their scripted
clicks are Aiden Workspace names); `batch47-campaigns.test.tsx` pins the
wizard's and the template editor's Classic markup to main's hash, and
`batch48-customers.test.tsx` pins the classic Customers files. Both pass.

```
SAME ai-assistants-desktop.png 
SAME ai-assistants-mobile.png 
SAME avatar-menu-desktop.png 
DIFF avatar-menu-mobile.png 124 px (0.009%)
SAME billing-desktop.png 
SAME billing-mobile.png 
DIFF campaign-results-desktop.png 518 px (0.040%)
SAME campaign-results-mobile.png 
DIFF campaigns-desktop.png 36 px (0.003%)
SAME campaigns-empty-desktop.png 
SAME campaigns-empty-mobile.png 
SAME campaigns-mobile.png 
SAME cards-desktop.png 
SAME cards-mobile.png 
SAME contacts-desktop.png 
SAME contacts-empty-desktop.png 
SAME contacts-empty-mobile.png 
SAME contacts-mobile.png 
SAME home-draft-desktop.png 
DIFF home-draft-mobile.png 124 px (0.009%)
DIFF home-empty-desktop.png 36 px (0.003%)
DIFF home-empty-mobile.png 124 px (0.009%)
DIFF home-new-desktop.png 32 px (0.002%)
DIFF home-new-mobile.png 124 px (0.009%)
DIFF home-off-desktop.png 36 px (0.003%)
DIFF home-off-mobile.png 121 px (0.009%)
DIFF home-replying-desktop.png 36 px (0.003%)
DIFF home-replying-mobile.png 122 px (0.009%)
DIFF inbox-chat-desktop.png 1172 px (0.090%)
DIFF inbox-chat-mobile.png 3349 px (0.254%)
SAME inbox-empty-desktop.png 
SAME inbox-empty-mobile.png 
SAME inbox-list-desktop.png 
SAME inbox-list-mobile.png 
DIFF palette-desktop.png 135 px (0.010%)
SAME palette-mobile.png 
SAME receipts-desktop.png 
SAME receipts-mobile.png 
SAME segments-desktop.png 
SAME segments-mobile.png 
SAME settings-desktop.png 
SAME settings-mobile.png 
SAME templates-desktop.png 
SAME templates-mobile.png 

29 identical, 15 different
```
