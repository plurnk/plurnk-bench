# Addresses Are All You Need

**Curation, not compaction, is how a model should spend its attention**

Matt Parrott, independent. October 2026. Draft.

> **Contribution statement.** Claude (Anthropic, Fable 5.1), operating in this project under the
> forge identity `plurnk_claude`, designed and implemented much of the harness and the bench described
> below alongside the author and a second agent, `plurnk_codex`; ran the campaigns; computed every
> analysis in this paper; and drafted the text, which the author directed and revised. Publisher and
> arXiv policy do not permit an AI system to be listed as an author. The author takes responsibility
> for the content. The commit history of the repositories named under *Availability* records the
> division of work.

## Abstract

Agent harnesses manage a model's context by compaction. When the transcript grows past a threshold,
the harness drops old turns, summarizes them with another model call, or both. We argue that
compaction is a habit inherited from an architecture in which context had no addresses, and that it
answers the wrong question: it optimizes for capacity, how much fits in the window, when the scarce
resource is attention, what the model is looking at when it decides. We describe the alternative,
curation: every item in the model's context, including its own past programs and observations, has a
durable address; results are offered sized by the request rather than pushed whole; and the model
shapes what it sees with ordinary verbs over those addresses, without ever losing the record. We
state the contract as a small set of invariants and give evidence from 90 attempts on 30 SWE-bench
Lite tasks with a cheap model, comparing a curation harness with a conventional one under the same
protocol. The curated context grew sixfold over an attempt against nineteenfold for the transcript,
with a third fewer prompt tokens per call, at a resolve rate the comparison cannot distinguish (66
against 59 of 90) and a cost within 1.3 times. The model shaped its context on nearly every turn,
through ranged reads, pattern search and notes, and almost never by eviction. Neither arm's capacity
machinery fired, because the window was a million tokens. The attention argument therefore stands on
its own; the capacity argument awaits a capped study, which we specify.

## 1. The habit

Consider how an agent harness is built today. A loop sends the model a transcript and receives either
prose or a request to call a tool. The harness executes the tool, appends the result, and sends the
transcript again. The transcript is a tape: the model can read it from the start and do nothing else
with it. It cannot point at the third result from an hour ago, discard the half of a build log it no
longer needs, or compare two observations without re-reading both in full. Every result that arrives
is an obligation, because it will be in front of the model on every subsequent call until something
removes it.

Something must remove it, because the world is larger than the window. In nearly every harness that
something is compaction: when the transcript reaches a fraction of the context window, the harness
drops older turns, asks a model to summarize them, or both, and continues with the summary in place
of the record. Compaction is universal enough to pass unremarked. It is in the terminal agents, the
coding platforms, the research frameworks and the SDKs. It is treated as a fact about agents rather
than a decision about them.

This paper argues that it is a decision, and the wrong one. Compaction exists because context had no
addresses. If an observation cannot be named, the only operations available on it are to keep it or
to destroy it, and the only party positioned to decide is the harness, which cannot see which
observations the task still needs. Give every item an address, and a third option appears: leave it
where it is, out of the window, reachable by name. Once that option exists, the model can be given
the verbs to use it, and the harness can stop deciding what the model will forget.

The contributions are three.

1. An argument that compaction optimizes for capacity rather than attention, and that the two come
   apart in practice (§2).
2. A description of curation as a harness contract: addressability, pull rather than push, selection
   as the unit of attention, and a division of labour in which the harness observes and the model
   decides, stated as invariants (§3, §4).
3. Evidence that a general-purpose model executes the contract on real tasks without fine-tuning,
   from 90 attempts under a published protocol against a conventional harness, with a census of what
   the model actually did to its context (§5), and a specification of the capped study that would
   test the capacity half of the argument (§6).

The harness used as evidence is Plurnk, an open-source daemon. The paper is not about it. It appears
because the industry conviction that a model cannot be trusted to manage its own context is an
empirical claim, and one working counterexample is enough to make it an open question.

## 2. Compaction optimizes for capacity, not attention

Two problems hide under the phrase "context management". The first is capacity: the request must fit
in the model's window, with room left for a response. The second is attention: of what fits, what is
the model actually attending to when it decides, and is that the right material. Compaction solves
the first and is indifferent to the second. It fires only when the window is nearly full, and until
then every pushed result remains in front of the model, whether or not it still matters.

The attention problem is real and measured. Liu et al. showed that models use information at the
start and end of a long context far better than information in the middle, and that performance on
multi-document questions falls as the context lengthens even when the answer is present
[@lost-in-the-middle]. Hong, Troynikov and Huber tested eighteen frontier models on tasks that were
deliberately trivial and found accuracy degrading with input length alone, non-uniformly, and
sensitively to distractors and to the structure of the surrounding material [@context-rot]. A
transcript that grows by a thousand tokens per call is, on this evidence, a context whose signal is
diluted by every call, long before any compaction threshold is reached. A harness that waits for the
window to fill is spending the model's attention on everything that was ever pushed into it.

Compaction has three further properties that follow from its position in the architecture.

- **It is blind to liveness.** The harness does not know which observations the task still needs.
  It frees by age and summarizes by guess. The analogy is a garbage collector that cannot see which
  objects are live, so it collects the oldest.
- **It is lossy and irreversible.** A summary replaces its sources; what the summary omitted is gone
  from every subsequent call. A model that later needs the exact line it saw forty turns ago cannot
  have it.
- **It is authored by the wrong party.** The only component that understands the task is the model.
  Compaction is performed by the harness, or by a second model call with no stake in the task, on the
  model's behalf and without its decision.

None of this is an argument that compaction fails to keep requests within the window. It does. The
argument is that fitting was never the interesting problem. The interesting problem is what the model
is looking at, and compaction leaves that entirely to the order in which things happened to arrive.

Why, then, is compaction universal? Because the transcript architecture leaves no alternative. With a
tape, the only operations are append and truncate. The decision to compact is forced by the decision
to make context a tape. The next section describes what becomes possible when it is not.

## 3. Curation

Curation is the model shaping its own context with ordinary operations over addressed items. It has
four parts, and each depends on the one before.

### 3.1 Addressability is the precondition

What cannot be named cannot be acted upon. In a curation harness every item the model might see or
want has a durable address: a file in the project, a line range within it, the output stream of a
running process, an observation the model made on an earlier turn, a program it emitted, a note it
wrote, another agent in the same workspace, a resource on the web. The addresses share one grammar,
so the verbs that work on files work on the model's own past.

Two consequences follow. Memory becomes random-access rather than sequential: the model's history is
a space to navigate, not a tape to rewind. And authority can attach to names: reading is free while
acting on the world is proposed, so consent becomes a property of addresses and effects rather than a
list of tools.

### 3.2 Memory belongs to the program

With addresses in place, the model's working memory, the packet it receives each turn, can be a view
over a durable store rather than the store itself. Every observation becomes a row in a journal with
an address and a weight. The packet shows the model the size of its room and, under pressure, its
heaviest rows. The model curates with the same verbs it uses on everything else: a `KILL` retires
rows or ranges from the view, and its body is the model's own note on what it is keeping; a ranged
`READ` brings back exactly the lines wanted; `MOVE` and `COPY` carry text between the journal and
files; a `NOTE` records what the model learned in its own words.

Nothing is lost. Curation changes what the model sees, never the record. Every observation, program
and note stays at its address, readable again if needed. Forgetting becomes reversible, and a summary,
when the model chooses to write one, is the model's decision in the model's words. This is the
distinction that matters against compaction: compaction edits the record; curation edits the view.

### 3.3 Pull, not push

If memory belongs to the program, the harness must not fill it unasked. A conventional harness pushes:
a command prints ten thousand lines and all ten thousand land in the transcript. A curation harness
offers, and what arrives is sized by what was asked for.

- A precise request, a line range or a pattern, is answered exactly.
- A loose request, or none, is answered with a preview: the first page and one line stating the
  whole, such as `<1,100> of 4812 lines`.
- Anything too large for the room arrives as a receipt: its size, its address and the verbs that
  will fetch a piece of it.

In every case the rest stays at its address until the model decides it is worth the room. This is
demand paging for attention. Everything is mapped; nothing is loaded until touched. A receipt is to
content what a directory listing is to a file system: enough to decide, without making the decision
the cost. Because the content stays addressable, no decision is final.

### 3.4 Selection is how attention is spent

The decision an agent makes most often is what to look at. A repository has a million lines, a build
log ten thousand, and the task needs a few dozen. A harness that offers only "read the file" forces
the model to spend attention finding out what deserves attention. A curation harness gives selection
one slot in every statement, with the same dialects on every resource: a line range, a literal or
glob, a regular expression, a structural query, a full-text search, a symbol-graph query. The regular
expression that filters a source file also filters a build log, a web page, and the model's own
history. Programmable selection is programmable attention: the model stops reading the world and
starts querying it.

### 3.5 The division of labour

The harness observes and informs; the model decides and acts. The harness measures the packet,
reports its size and its budget, names the heaviest rows when the room is tight, and refuses to send
a request the provider cannot accept. It does not summarize, drop, fold or reorder anything the model
did not ask it to. The consequence for research is as important as the consequence for design: a
harness that adds no mechanism of its own is a clean instrument. Whatever the context does over a run
is what the model did to it.

### 3.6 What this is not

Curation is not retrieval-augmented generation: nothing is embedded or ranked by a second system, and
the model names what it wants by address or pattern. It is not MemGPT's tiered memory, in which the
model pages information between a main context and archival stores through dedicated functions but
the system still evicts and summarizes under pressure and the model's memory remains a different kind
of thing from the world it works on [@memgpt]; in a curation harness the journal is in the same
address space as the files and streams, and the same verbs reach all of them. It is not a different
tool set: SWE-agent showed that the interface designed for an agent matters as much as the model
behind it [@swe-agent]; curation is a claim about what that interface should be made of, namely
addresses and a small set of orthogonal verbs, rather than a claim about which tools to provide.

## 4. The contract

A design that can be stated as invariants can be tested, taught and reasoned about without a
whiteboard. The curation harness used as evidence states its context contract in a specification;
the invariants that matter for this paper are these, paraphrased from their tagged declarations.

| Invariant | Statement |
|---|---|
| One room | The budget is the provider's input capacity through a per-loop calibration, and it bounds the whole packet: teaching, catalog, journal and gauge together. No part of the packet is sized separately. |
| One gauge | Every packet carries one `Context` section with the packet's weight and the known budget. Only when the packet exceeds a configured share of the budget does the gauge name the heaviest retained rows. The gauge is state; it carries no mandate. |
| Pressure is one notice | When the gauge names its inventory and the packet still fits, the packet carries one warning: "Context is at *N*% of budget." It recurs on every such packet and is never sent to clients. |
| Whole if it fits, otherwise as much as fits, then its size and address | A result the model asked for arrives complete when it fits in the room the turn still has; otherwise the complete result stays at its address and the row is a receipt naming the size, the remaining budget, and the two verbs that fetch a piece. An arrival the model did not ask for takes the same receipt as a fact, not an error. |
| The verbs are the curation | A ranged `READ` takes a piece of what did not fit; `NOTE` keeps what the model learned; `KILL` retires rows, ranges and bodies and may carry what it keeps of them as its own note. The daemon adds no other mechanism. |
| Over budget is a row and a request, not an ending | A packet over budget is still sent when it fits the window, and it carries one error row at the head of the turn: "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn." Nothing is hidden to make the packet smaller. |
| Only the window ends a loop | A request over the provider's physical limit sheds its newest bodies into receipts, newest first, only as many as it takes to fit; each body stays stored and readable at its address. A packet that cannot fit even as receipts ends its loop with an explicit problem, and no inference request is made. The daemon chooses nothing to summarize and hides nothing silently. |

Three things about the table deserve notice. The harness never decides what to drop: shedding under
the physical wall turns bodies into receipts, by recency, and leaves every body at its address, so
even the last-resort mechanism is reversible. The pressure notice and the over-budget row are
information and a mandate, respectively, not actions: the harness tells the model the state of its
room and, past the budget, that the next turn must be a curation turn, and leaves the choice of what
to curate to the model. And the budget is one number bounding one packet, so the model's teaching
material competes for room with its observations on equal terms; a design that reserved a separate
share for teaching would be hiding a cost.

## 5. Evidence: an uncapped room

### 5.1 Setup

The evidence is a published campaign of two arms run concurrently on one machine on 2026-10-11 with
the same model, route, task set, prompt, attempt count and evaluator [@evidence-release]. The task set
is the 30 SWE-bench Lite instances used by the HarnessTax study of coding-agent harnesses
[@harnesstax; @swe-bench], at three attempts per task, with the study's turn cap of 100 for the
curation arm and a cap of 1000 for the comparator so that no comparator attempt is cut short. The
model is DeepSeek Flash at low reasoning effort on DeepSeek's own endpoint, the only host the
container may reach; its context window is one million tokens. The curation arm is Plurnk 3.1.0 with
its package defaults and its model-facing card at that release. The comparator is Pi 0.99.1, a
conventional terminal coding agent with tool calls and a growing transcript, installed from npm with
its default system prompt and tools [@pi]. The oracle is the official SWE-bench harness over each
attempt's working-tree diff. Costs are DeepSeek's list schedule applied to the provider-reported usage
of every request in both arms.

Two facts about the setup bound what the evidence can say. The 30 tasks were the set the curation
arm's configuration was developed against; they are not held out. And at a million tokens of window,
neither arm came within an order of magnitude of capacity, so nothing below tests compaction against
curation under pressure. What it tests is the attention claim: given addresses and pull, what does the
model do, and what does its context look like.

### 5.2 Outcome and cost

| Arm | Resolved of 90 | 95% interval | Spend | Per solve | Median model calls | Prompt tokens (cache hits) | Output tokens (reasoning) |
|---|---:|---|---:|---:|---:|---:|---:|
| Curation (Plurnk 3.1.0) | 66 (73.3%) | 63.4–81.4% | $2.835 | $0.043 | 33 | 73.1M (95.1%) | 3,478k (3,011k) |
| Transcript (Pi 0.99.1) | 59 (65.6%) | 55.3–74.6% | $2.197 | $0.037 | 42 | 147.8M (98.5%) | 2,374k (1,775k) |

The intervals overlap and a paired sign-flip permutation test over the 30 tasks gives p = 0.121;
90 cells do not separate the two resolve rates, and an earlier campaign on the same set with an
earlier release pointed the same way (68 against 60). The paper claims parity, not an advantage.
The spend ratio is 1.29.

### 5.3 What the context looked like

Both arms record the provider-reported prompt tokens of every request, so the size of the model's
context on every call of every attempt is in the published record. Table 3 follows the median packet
through an attempt, by position in the attempt (so that long and short attempts weigh equally) and by
absolute call index (where the later rows include only the attempts that lasted that long).

| Position in attempt | Curation: median (q1–q3) prompt tokens | Transcript: median (q1–q3) |
|---:|---:|---:|
| first 5% | 4,456 (4,239–4,853) | 2,124 (1,901–2,461) |
| 25% | 15,633 (11,636–22,624) | 17,550 (10,827–25,569) |
| 50% | 22,658 (16,218–33,205) | 37,939 (20,099–54,281) |
| 75% | 27,424 (20,067–41,895) | 53,523 (26,779–75,762) |
| last 5% | 29,162 (22,034–44,451) | 53,575 (30,613–88,993) |

| Call index | Curation: attempts alive, median | Transcript: attempts alive, median |
|---:|---:|---:|
| 1 | 90, 4,337 | 90, 1,901 |
| 10 | 88, 13,884 | 90, 9,786 |
| 20 | 74, 21,433 | 77, 20,144 |
| 30 | 51, 27,189 | 57, 31,146 |
| 40 | 28, 37,109 | 46, 42,714 |
| 60 | 6, 42,365 | 27, 65,660 |
| 80 | 1, 46,778 | 12, 89,815 |
| 100 | — | 3, 115,550 |

| Per attempt | Curation | Transcript |
|---|---:|---:|
| Mean prompt tokens per call | 24,009 | 35,339 |
| Largest packet, median across attempts | 27,055 | 37,067 |
| Largest packet, 90th percentile | 52,914 | 97,126 |
| Largest packet, maximum | 88,073 | 151,338 |
| Growth, last call over first, median | 6.3× | 19.1× |
| Growth, maximum | 17.9× | 70.3× |
| Attempts in which the context ever shrank between calls | 4 | 0 |

Three features stand out. The curated packet starts heavier, because the model's teaching card is in
it: about 4,300 tokens on the first call against 1,900. The curves cross near the twentieth call and
then diverge: by the last calls of an attempt the transcript's median is 1.8 times the curated
packet's, and its upper quartile twice. And the transcript never shrinks, because nothing in the
comparator ever removes anything short of compaction, which never fired; the curated packet shrank in
four attempts, which is to say almost never either. The curated context is smaller not because the
model threw things away but because less arrived.

### 5.4 What the model did to its context

The curation arm's daemon records every statement the model emitted, so the campaign supports a
census of how the model actually shaped its context, from the 90 run databases.

| Operation | Count | Of which |
|---|---:|---|
| Model turns | 3,043 | 888 (29%) carried only a `NOTE` |
| Statements | 6,083 | 70 refused (1.2%) |
| `NOTE` | 2,840 | 0.93 per turn |
| `READ` | 1,104 | 875 by line range, 144 by pattern, 85 whole; 1,092 of files, 12 of process streams |
| `FIND` | 634 | 502 regular expressions, 110 literal or glob, 7 full-text, 2 glob, 1 symbol-graph, 12 other |
| `sh` | 788 | |
| `EDIT` | 468 | |
| `SEND`, `WAIT`, `WORK` | 97, 39, 1 | |
| `KILL` | 45 | 34 on the journal, in 5 attempts, retiring 154 rows; 9 on files the model had created; 2 on process streams |
| `COPY`, `MOVE` | 0 | |

| Capacity machinery | Count |
|---|---:|
| Packets carrying a pressure notice | 0 of 3,044 |
| Over-budget rows | 0 |
| Receipts for results that did not fit | 0 |
| Previews, a first page with the whole stated | 37 |
| Largest packet as a share of its budget | 12.4% |
| Median largest packet, in the daemon's curation units | 38,412 of a budget near 1,000,000 |

The picture is consistent. The model shaped its context on nearly every turn by asking precisely:
79% of its reads named a line range and a further 13% a pattern; 79% of its searches were regular
expressions; and it wrote a note on 93% of its turns. It almost never curated by eviction: 34
journal kills in 5 of 90 attempts, 30 of them in one attempt that retired its own old programs turn by
turn. The capacity machinery never spoke, because the packet never came within a factor of eight of
its budget. Whatever the harness's pressure notice, over-budget row and receipts do under load, this
campaign did not exercise them, and nothing below should be read as evidence that it did.

### 5.5 What the arithmetic says

Put together, the three tables say this. With addresses and pull, the model read about a third fewer
prompt tokens per call than the transcript harness, its context grew at a third of the rate over an
attempt, and it resolved tasks at a rate the comparison cannot distinguish from the comparator's. It
achieved this without eviction, by selection: ranged reads, pattern searches and notes. The size
difference is a property of the architecture, not of the model's diligence.

The size difference did not become a cost difference, and the reason is instructive in both
directions. With provider-side prompt caching, a transcript that grows monotonically is nearly free
to resend: 98.5% of the comparator's prompt tokens were cache hits, billed at two percent of the
uncached rate. The dollar case for a smaller context is therefore weak on a cached route, and the
paper does not make it. The argument for curation is attention, not money.

The curation arm cost more, and the whole of the difference is reasoning. The two arms' output tokens
differ by 1.1 million, of which 1.24 million is reasoning, billed as output: 3.01 million against
1.78 million. The curation arm's reasoning has a long tail: 49 of its 3,044 calls carried over ten
thousand reasoning tokens and 7 over twenty thousand, with a maximum of 35,408; the comparator had
one call over ten thousand and a maximum of 10,267. The mechanism, examined on an earlier campaign on
the same set, is re-derivation. The comparator's protocol returns the model's prior reasoning to the
provider with each tool-call request, and the provider continues the chain of thought; the curation
arm's text protocol does not, so after a turn that records a decision without acting on it the model
derives the decision again. Twenty-nine percent of the curation arm's turns carried only a note. An
experiment that replayed the model's reasoning as journal rows did not help: resolve rate within
noise, cost flat, packets fifty percent heavier. The open lever is behavioural, acting in the same
turn as the decision, and it is the cost of this design as currently taught.

### 5.6 Limitations

One model at one effort on one route; 30 tasks that the curation arm's configuration was developed
against; 90 cells per arm, which do not separate the resolve rates; a window that neither arm
approached, so the capacity half of the argument is untested here; and a cached route on which a
larger context costs little, so the case rests on attention. The comparator ran as installed; its
compaction never fired and its context grew without bound within the window. The two arms ran at
different lane counts, which affects wall time and nothing in the tables.

## 6. The capped room

The uncapped campaign tests the attention claim and leaves the capacity claim untested. The study that
tests it is the same protocol with the window capped on both arms so that capacity binds in a
majority of attempts, and it is specified here so that it can be run and judged against this text.

Both harnesses take the cap as configuration. The curation harness accepts an operator cap on the
context window that reduces known capacity and derives its budget from it; its output reservation and
output floor are likewise configuration. The comparator's bench profile carries a context window and
a compaction partition, the reserve below the window at which compaction triggers and the recent span
it keeps. For parity, both arms reserve the same room for output, so that the comparator compacts and
the curation arm's budget binds at the same input size.

The uncapped campaign's per-attempt maxima say where a cap would bind. They are lower bounds on how
many attempts would touch the machinery, since behaviour changes once a cap binds.

| Input room | Curation attempts whose largest uncapped packet exceeded it | Transcript attempts |
|---:|---:|---:|
| 24,000 | 54 of 90 | 60 of 90 |
| 32,000 | 30 | 51 |
| 48,000 | 14 | 36 |
| 64,000 | 3 | 29 |

A 64k window with 16k reserved for output leaves 48k of room: the comparator would compact in roughly
four attempts in ten and the curation arm's pressure notice would appear in perhaps a quarter. A 32k
window with 8k reserved leaves 24k: both arms bind in a majority, and the curation arm's fixed
teaching cost, about 4,300 tokens, becomes a visible eighteen percent of the room. The quantities the
capped study reports are the ones this paper could not: compactions per attempt and what they
discarded; pressure notices, over-budget turns, receipts and journal kills per attempt and what the
model chose to retire; resolve rate and cost against the uncapped campaign for each arm; and the
failure modes at the wall, where the comparator summarizes and the curation harness sheds bodies into
receipts and, past that, ends the loop.

### 6.1 Three specimens at a 16k room

Before any campaign, four single attempts were run at that partition on 2026-10-12 and read turn by
turn: three on the curation harness, one on the comparator, same model and prompt, the harness at
the pushed main after the 3.1.0 release. Their purpose was to find out whether the model executes the
contract under pressure at all, and what the teaching lacks, before a campaign could measure anything.

| Task | Arm | Calls | Cost | Largest packet | Room events | Verdict |
|---|---|---:|---:|---:|---|---|
| matplotlib-25433 | curation | 31 | $0.024 | 102% of budget, once | 10 pressure notices, 1 mandate, 12 KILLs retiring 43 rows | pass |
| matplotlib-25433 | transcript | 83 | $0.121 | 20.2k tokens | 15 compactions | pass |
| pytest-5103 | curation | 66, two workers | $0.073 | 115%, in a child | 12 pressure notices, 4 mandates, 53 KILLs retiring 206 rows | pass |
| django-11564 | curation | 80 | $0.069 | 99%, never over | 36 pressure notices, no mandate, 30 KILLs retiring 148 rows | fail, as all six uncapped attempts in both arms |

For reference the uncapped campaign's mean cost on those tasks was $0.062, $0.102 and $0.059 for the
curation arm and $0.021 for the comparator on the first.

The contract held in all three curation runs. Every mandate turn carried only KILL and NOTE; every
pressure notice was answered within three turns by a KILL, usually with a distillation in its body;
the wall was never reached. In one run the model answered pressure by starting a child worker with a
written brief and waiting for its result, which is delegation used as curation: a new process is a
new room. The model also re-read ranges it had just retired when a bulk KILL carried no distillation,
which is the cost of eviction without notes, and 29 to 30 percent of its turns in each run carried
only a NOTE.

The comparator's single run shows the compaction mechanism at this scale. Its context grew to the
trigger by the twenty-second call and compacted fifteen times in the sixty-one calls after, every three
to five calls. Each compaction is a model-written summary, and the summaries are cumulative: they grew
from 2.8k to 31k characters, about 72k output tokens in all, so that by the end the summary alone was
near half the room and every refill was short. Each compaction also rewrote the prompt prefix, and the
cached share of prompt tokens fell from 98.6% in the uncapped run to 69%. The curation run on the same
task paid neither: a KILL is a one-line statement, the retired rows stay at their addresses, and the
cache survived at 80%. One task and one attempt each, so this is a mechanism exhibited, not a rate.

The specimens also named what the teaching lacked, which is their job. In all three curation runs the
model lost turns under pressure to the shape of a journal coordinate: five segments where there are
four, a bar-separated list of complete coordinates, a bracketed comma list, each drawing either a
silent no-match 204 or a refusal that named no shape. The harness now reads each of those four shapes
as the one target it can only have meant, with no new text in the packet, and a target nothing can
read is refused with the coordinate form; the card is unchanged, since its one KILL example already
shows the form. Twice the model tried to keep a command's output out of its
context by inventing a form, a COPY of a command and a `stream` metadata field on a shell statement;
the card had not told it that unscoped output arrives as a first page. And the over-budget row, being
durable, stood in later packets as a stale mandate until the model retired it.

## 7. Related work

MemGPT framed the language model as an operating system managing its own memory hierarchy through
function calls, paging between a main context and external stores [@memgpt]; curation shares the
premise that the model should manage its memory and differs in making the memory an addressable
journal in the same namespace as the files and processes the model works on, edited with the same
verbs, and in adding no eviction or summarization of the harness's own. CodeAct showed that models act
more reliably through executable code than through JSON tool calls [@codeact]; the curation harness
takes the same side, with every statement a fenced block in conventions the model has already read.
SWE-agent introduced the agent-computer interface as a design object and showed its effect on
outcomes [@swe-agent]; the present argument is about what such an interface should be made of.
OpenHands ships context condensation as a pluggable component with several strategies, from dropping
old events to summarizing them with a model call [@openhands; @openhands-condenser]; it is the
clearest statement of the compaction position, and the clearest contrast. HarnessTax measured how much
the harness matters across three coding agents on a fixed task set [@harnesstax]; this paper borrows
its protocol and adds a fourth design point. Liu et al. and Hong et al. supply the attention evidence
that the argument rests on [@lost-in-the-middle; @context-rot]. Pi and mini-SWE-agent represent the
minimal transcript harness at its best [@pi; @mini-swe-agent]; the comparison here is against Pi as
installed.

## 8. Conclusion

Compaction is not a law of agents. It is the consequence of a tape. Give the model's context addresses
and the forced choice between keeping and destroying dissolves into a third option, leaving things
where they are and reachable by name, and the party that understands the task can be given the verbs
to decide what it looks at. On the evidence here, a general-purpose model takes those verbs up without
being trained on them: it reads by range and searches by pattern on nearly every turn, writes notes in
its own words, and keeps its context at a third less per call and a third of the growth, with no
detectable penalty in outcomes and at a cost whose whole excess is reasoning it would not have needed
had it acted when it decided. What the model does when the room actually binds is the next
measurement, and the contract that lets it be measured cleanly, a harness that adds nothing of its
own, is the paper's practical recommendation whatever that measurement shows.

## Availability

The campaign, with every attempt's diff, oracle report, per-request token ledger and launch
configuration, is published as a release of the bench repository [@evidence-release]. The analyses in
§5.3 and §5.4 are two scripts over that release and the campaign's run databases, published beside
this paper. The harness, its contracts and its model-facing card are open source under the MIT license
at <https://github.com/plurnk/plurnk-service>; the terminal client at <https://github.com/plurnk/plurnk>;
the bench at <https://github.com/plurnk/plurnk-bench>.

## References

- [@lost-in-the-middle] N. F. Liu, K. Lin, J. Hewitt, A. Paranjape, M. Bevilacqua, F. Petroni, P. Liang. *Lost in the Middle: How Language Models Use Long Contexts.* TACL 2024. arXiv:2307.03172.
- [@context-rot] K. Hong, A. Troynikov, J. Huber. *Context Rot: How Increasing Input Tokens Impacts LLM Performance.* Chroma technical report, July 2025. <https://research.trychroma.com/context-rot>.
- [@memgpt] C. Packer, S. Wooders, K. Lin, V. Fang, S. G. Patil, I. Stoica, J. E. Gonzalez. *MemGPT: Towards LLMs as Operating Systems.* arXiv:2310.08560, 2023.
- [@codeact] X. Wang, Y. Chen, L. Yuan, Y. Zhang, Y. Li, H. Peng, H. Ji. *Executable Code Actions Elicit Better LLM Agents.* ICML 2024. arXiv:2402.01030.
- [@swe-agent] J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, O. Press. *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.* NeurIPS 2024. arXiv:2405.15793.
- [@swe-bench] C. E. Jimenez, J. Yang, A. Wettig, S. Yao, K. Pei, O. Press, K. Narasimhan. *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?* ICLR 2024. arXiv:2310.06770.
- [@openhands] X. Wang et al. *OpenHands: An Open Platform for AI Software Developers as Generalist Agents.* ICLR 2025. arXiv:2407.16741.
- [@openhands-condenser] *OpenHands Context Condensation for More Efficient AI Agents.* OpenHands blog, April 2025. <https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents>.
- [@harnesstax] *HarnessTax: How Much Does the Harness Matter for Coding Agents?* <https://harnesstax.github.io/>.
- [@pi] Pi coding agent, npm package `@earendil-works/pi-coding-agent`, version 0.99.1.
- [@mini-swe-agent] mini-SWE-agent. <https://github.com/SWE-agent/mini-swe-agent>.
- [@evidence-release] *Plurnk 3.1.0 and Pi 0.99.1 on the HarnessTax SWE-bench Lite task set: DeepSeek Flash at low effort, 30 tasks × 3 attempts.* plurnk-bench release `evidence-2026-10-11-deepseek-flash-plurnk-vs-pi`, 2026. <https://github.com/plurnk/plurnk-bench/releases/tag/evidence-2026-10-11-deepseek-flash-plurnk-vs-pi>.

*Citations to verify before submission: the OpenHands venue and arXiv identifier; the Context Rot
report's authors and URL; the HarnessTax study's authors and date, which its site carries; the exact
Pi package name and author. Two 2026 arXiv preprints on condensation strategies and on the
architecture of eleven coding-agent harnesses surfaced in a search (2605.18854, 2609.00006) and belong
in §7 if they check out.*
