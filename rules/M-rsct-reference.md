## §M — RSCT reference in what is recorded

This project is governed by the RSCT Framework. Mark what it records:

- **Commit messages** carry this trailer in the trailer block at the end of the message (git
  trailer form, next to any other trailer):
  `Governed-by: RSCT-Framework <https://github.com/raphaelfnds/rsct-framework>`
  The trailer counts toward `commit_message_max_lines`. When the message would go over that cap,
  shorten the message; never raise the cap to make room. With a cap of 1 the trailer is left out.
- **ADRs (§H) and issues**: the last line of the ADR entry, and of the text you write for an
  issue, is
  `Governed by RSCT-Framework — https://github.com/raphaelfnds/rsct-framework`
  (a tool such as `rsct_capture_issue` may add its own sections after it, such as affected paths
  and a footer).
- Memory entries and chat answers carry no reference.
