# Hard cases (read when a ticket doesn't fit the flow)

Real incidents. Each line: the situation → what to do.

**Nothing to groom**
- WORKSTREAMRE-362…369: title "Organogram Page:" only, no description, attachments or links → `resolve` refuses; report, and let triage send it back as needs-info. Never invent the request from the title.

**Looks like one area, is another**
- #8772 "payroll People Report amount malformed" was fixed in `frontend/src/common/utils/misc.js` (shared, yellow) → describe the symptom; don't name payroll files as the fix location. Zones are decided by the files touched, and Oneshot re-checks them.
- "Forgot password page contrast" is a Django template, not React; "Android - <screen>" is the same React + Django code → trust `layers`, don't correct it from the title.

**Duplicates**
- WS-232 was groomed twice → an `(open)` context line asking for the same outcome = stop and report "possible duplicate of #N".
- False positive: open accessibility issues on the same page but a different control are not duplicates → same page ≠ same request.

**Documents**
- WORKSTREAMRE-230 links a private Google Sheet the Drive connector can't open → leave the ⚠️ link `create` wrote and report it; never paste a summary of a file you couldn't read.

**Untriaged ticket**
- WORKSTREAMRE-357 had no triage marker → it goes to people with `[no triage route]`, even if it looks automatable. Never add `AI` yourself: a person decides, and adding `AI` on GitLab is how they hand it to Oneshot.
