# Sessions and runs

A **session** is a conversation with the agent inside one workspace. A **run**
is one turn of it: your message, everything the agent did with it, and the
outcome. Sessions accumulate context; runs are the unit of cost, status and
undo.

## The composer

The controls under the input change what the *next* message does:

- **Model** — what the CLI offers your subscription, by name. **Auto** hands
  the choice to the learned policy, which picks from what has actually worked
  for this kind of task.
- **Effort** — how hard the model thinks, from Low to Maximum. Only the levels
  the chosen model supports are offered.
- **Permission mode** — see the Permissions chapter. The composer border turns
  red under Bypass, and a banner says so.
- **Ultracode** — appears only when the chosen model can orchestrate: one
  toggle fans your message out across sub-agents at maximum effort. Expect
  multi-agent token spend; the hint under the composer reminds you while it is
  on. It is a per-message choice by design — nothing can leave it quietly
  enabled.
- **Tools** — normally the agent knows its skills and MCP servers and uses
  its judgement; this picker is for the times you want to steer. Require a
  skill (only the required ones load, and the requirement is written into
  the run), switch an MCP server off (it is simply not mounted for this
  message), or mark one preferred (it stays mounted and the agent is asked
  to reach for it first). A summary under the composer shows what is
  steered, the run's result carries a "tools steered" chip, and — like
  Ultracode — it is per-message: nothing stays quietly forced. Steering
  never widens a permission; every approval rule still applies.

Enter sends. Shift+Enter inserts a newline.

## Attaching files

The paperclip attaches files to your next message — up to 8, 20 MB each.
Drag & drop onto the composer and pasting a screenshot straight from the
clipboard both work; on a phone, the picker offers the camera and the photo
library. Accepted types: images (PNG, JPEG, WebP, GIF), PDF, text (plain,
Markdown, CSV, HTML, JSON), ZIP archives, and Word/Excel documents.

Every attachment is stored **in the workspace**, under `attachments/` — so the
agent reads it with its own tools (images and PDFs natively), it shows up in
the Files browser, and it stays part of the record. Small images and PDFs also
ride the message itself, so the model sees them immediately. In the
transcript, images render as thumbnails and other files as chips; both open
the stored bytes.

A chip can be removed until the message is sent; after that the file is part
of the transcript and stays. Uploading the same file twice stores it once.

## While a run is working

You can keep typing: a message sent into a live run **steers** it — the agent
reads it mid-flight. **Stop** ends the turn cleanly; the transcript is kept and
the run is recorded as interrupted, never as a success.

## After a run

Every result footer states **what actually ran**: the model — the one the CLI
itself reported serving, which under Auto is the only honest answer — the
effort, the permission mode, whether the learner made the choice, and an
ultracode marker when it applied. Hover the model chip for the requested-vs-
served detail.

- **Rate it.** The thumbs on a finished run are the strongest signal the
  learner gets — your judgement overrides every automatic metric.
- **Rewind it.** A run made with checkpointing on offers **Restore**: a
  preview of exactly which files would change, then the CLI's own file-level
  undo. Stop any live run in the session first.
- **Follow up.** A new message resumes the same Claude session — same context,
  new run, honest accounting.

## Sessions from the CLI

The Claude CLI keeps its own record of every conversation held in a directory —
including ones that never went through Metaclaude, such as a `claude` session
run in a terminal on the same machine. On the workspace page, **From the CLI**
lists them: title, last activity, git branch, and the first prompt.

**Adopt** binds one to a fresh Metaclaude session. From then on it behaves like
a native session — your next message resumes the same conversation with its
context intact, and steering, permissions and accounting all apply. A session
that is already adopted shows **Open** instead; adoption is one-to-one, so the
same CLI conversation can never end up behind two doors.

Only sessions the CLI itself lists for this workspace's directory are offered
or accepted — an id from anywhere else is refused.

## Cost

Each run shows its tokens and, where the CLI reports one, its cost. Analytics
aggregates them per workspace and ranks workspaces against each other — the
view that tells you which project is spending the ceiling.

Analytics also shows the **subscription quota** itself, as the CLI reports it:
the five-hour session window, the weekly windows, and any per-model buckets,
each with its utilisation and when it resets. Under them, the CLI's own
attribution of what has been consuming the quota — behaviours like heavy
sub-agent use, and the agents, skills, plugins and MCP servers involved. That
attribution is approximate by its own admission: it reads this machine's
transcripts, so other devices and claude.ai are not counted.
