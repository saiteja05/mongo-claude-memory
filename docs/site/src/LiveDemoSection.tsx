import { useEffect, useState } from 'react';
import { Terminal, Database, ArrowRight, ArrowDown, MousePointerClick, RefreshCw, ExternalLink } from 'lucide-react';

type Step = {
  label: string;
  mode: 'manual' | 'automatic';
  consoleText: string;
  isPlaceholder?: boolean;
  toolName: string;
  toolDescription: string;
  whyItMatters: string;
  collection: string;
  operation: string;
  doc: string;
};

const STEPS: Step[] = [
  {
    label: 'Hash-line capture',
    mode: 'manual',
    consoleText: '# always run migrations before seeding',
    toolName: 'UserPromptSubmit hook',
    toolDescription: 'Every prompt is checked, one starting with # is captured verbatim, no tool call needed.',
    whyItMatters:
      'Flag a convention or decision as worth remembering without breaking your typing flow, no separate command needed.',
    collection: 'claude_memory.observations',
    operation: 'insertOne',
    doc: `db.observations.insertOne({
  project: "ship",
  source: "hash_line",
  priority: "high",
  status: "pending",
  text: "always run migrations before seeding"
})`,
  },
  {
    label: '/remember command',
    mode: 'manual',
    consoleText: '/remember always run migrations before seeding the dev database',
    toolName: '/remember slash command',
    toolDescription: 'Writes your text to a temp file and runs remember.js, which calls writeObservation().',
    whyItMatters:
      'For deliberately dropping in a decision or fact you want kept, in more detail than a hash-line allows.',
    collection: 'claude_memory.observations',
    operation: 'insertOne',
    doc: `db.observations.insertOne({
  project: "ship",
  source: "remember",
  priority: "high",
  status: "pending",
  text: "always run migrations before seeding the dev database"
})`,
  },
  {
    label: 'Natural-language recall',
    mode: 'manual',
    consoleText: '"What did we decide about the rerank fallback order?"',
    toolName: 'memory_search MCP tool',
    toolDescription:
      'Hybrid ($rankFusion) search over consolidated beliefs, falls back to text-only or vector-only if Voyage or Atlas Search is unavailable.',
    whyItMatters: 'Claude can answer from what it already knows about this project, not just the current conversation.',
    collection: 'claude_memory.beliefs',
    operation: 'aggregate ($rankFusion)',
    doc: `db.beliefs.aggregate([
  {
    $rankFusion: {
      input: {
        pipelines: {
          vectorPipeline: [
            { $vectorSearch: { path: "embedding", index: "beliefs_vec" } }
          ],
          fullTextPipeline: [
            { $search: { index: "beliefs_text", text: { path: "text" } } }
          ]
        }
      }
    }
  }
])`,
  },
  {
    label: 'SessionEnd capture',
    mode: 'automatic',
    consoleText: '(nothing typed, session just ended)',
    isPlaceholder: true,
    toolName: 'SessionEnd hook',
    toolDescription: 'Fires automatically when the session ends, captures the last 50,000 characters of the transcript.',
    whyItMatters: 'Nothing gets lost just because you forgot to flag it: the whole session is captured as a safety net.',
    collection: 'claude_memory.observations',
    operation: 'insertOne',
    doc: `db.observations.insertOne({
  project: "ship",
  source: "transcript",
  priority: "normal",
  status: "pending",
  text: "...session summary..."
})`,
  },
  {
    label: 'Consolidator run',
    mode: 'automatic',
    consoleText: '(nothing typed, cron fires every ~15 min)',
    isPlaceholder: true,
    toolName: 'Consolidator',
    toolDescription: 'Claims pending observations, extracts a fact with Claude, and dedupes it against existing beliefs.',
    whyItMatters: 'Raw observations get turned into durable, deduplicated facts, without you doing anything.',
    collection: 'claude_memory.beliefs',
    operation: 'updateOne (upsert)',
    doc: `db.beliefs.updateOne(
  { text: "Ship repo uses trunk-based branching" },
  {
    $set: {
      type: "convention",
      scope: "project",
      importance: 0.8,
      status: "active",
      observation_ids: ["66f1a2c9e1b2f4a1c8d3e7f0", "66f1a3d0e1b2f4a1c8d3e7f1"]
    }
  },
  { upsert: true }
)`,
  },
  {
    label: 'SessionStart brief injection',
    mode: 'automatic',
    consoleText: '(nothing typed, new session starts)',
    isPlaceholder: true,
    toolName: 'SessionStart hook',
    toolDescription: 'Fires on session start, compact, or resume, fetches the compiled brief and injects it as additionalContext.',
    whyItMatters: "Every new session already knows your project's conventions: no re-explaining.",
    collection: 'claude_memory.briefs',
    operation: 'findOne',
    doc: `db.briefs.findOne({ _id: "brief:ship" })

// => {
//   _id: "brief:ship",
//   content: "Ship repo uses trunk-based branching...",
//   token_estimate: 214
// }`,
  },
];

const STEP_INTERVAL_MS = 4000;

function ModeBadge({ mode }: { mode: Step['mode'] }) {
  const isManual = mode === 'manual';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] sm:text-[10px] font-semibold uppercase tracking-wider ${
        isManual ? 'bg-[#85AB8B] text-[#1f2a1d]' : 'bg-white text-[#1f2a1d]'
      }`}
    >
      {isManual ? <MousePointerClick className="w-3 h-3" /> : <RefreshCw className="w-3 h-3" />}
      {isManual ? 'Manual' : 'Automatic'}
    </span>
  );
}

function LiveDemoSection() {
  const [currentStep, setCurrentStep] = useState(0);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setCurrentStep((s) => (s + 1) % STEPS.length);
    }, STEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [resetKey]);

  function jumpToStep(i: number) {
    setCurrentStep(i);
    setResetKey((k) => k + 1);
  }

  const active = STEPS[currentStep];

  return (
    <section id="how-it-works" className="relative w-full bg-[#f7f5ef] py-16 sm:py-20 md:py-28 px-4 sm:px-6">
      <style>{`
        @keyframes recallBlink {
          0%, 45% { opacity: 1; }
          50%, 95% { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes recallFadeIn {
          from { opacity: 0; transform: translateY(2px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .recall-cursor { animation: recallBlink 1s steps(1, start) infinite; }
        .recall-fade { animation: recallFadeIn 0.4s ease both; }
      `}</style>

      <div className="max-w-5xl mx-auto text-center mb-10 sm:mb-14">
        <span className="mb-2 sm:mb-3 inline-block text-[#4b5b47] text-xs sm:text-sm font-semibold uppercase tracking-[0.2em]">
          How to use it
        </span>
        <h2
          className="font-normal leading-[1.05] text-[#336443] text-2xl sm:text-3xl md:text-4xl max-w-3xl mx-auto"
          style={{
            fontFamily:
              '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
            letterSpacing: '-0.03em',
          }}
        >
          Pull detail beyond the context window, one Atlas pipeline at a time.
        </h2>
        <p className="mt-3 sm:mt-4 text-[#4b5b47] text-sm sm:text-base max-w-xl mx-auto">
          Every hook, cron run, and tool call on the left maps to a real write or query on the right: no invented steps.
        </p>
        <a
          href="https://github.com/saiteja05/mongo-claude-memory#using-it"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 sm:mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-[#336443] hover:text-[#1f2a1d] transition-colors"
        >
          More info
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <div className="max-w-5xl mx-auto mb-8 sm:mb-10 flex flex-col gap-4">
        {(['manual', 'automatic'] as const).map((mode) => (
          <div key={mode} className="flex flex-col gap-2">
            <span className="text-[10px] sm:text-xs uppercase tracking-wider font-semibold text-[#336443]">
              {mode === 'manual' ? 'Manual: 3 steps you trigger' : 'Automatic: 3 steps that happen for you'}
            </span>
            <div className="flex flex-wrap gap-2">
              {STEPS.map((step, i) =>
                step.mode === mode ? (
                  <button
                    key={step.label}
                    type="button"
                    aria-pressed={i === currentStep}
                    onClick={() => jumpToStep(i)}
                    className={`text-xs sm:text-sm px-3 py-1.5 rounded-full border transition-colors ${
                      i === currentStep
                        ? mode === 'manual'
                          ? 'bg-[#85AB8B] border-[#85AB8B] text-[#1f2a1d] font-semibold'
                          : 'bg-[#336443] border-[#336443] text-white font-semibold'
                        : 'border-[#336443]/20 text-[#4b5b47] hover:border-[#336443]/40'
                    }`}
                  >
                    {step.label}
                  </button>
                ) : null
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="max-w-5xl mx-auto flex flex-col lg:flex-row items-stretch lg:items-center gap-4">
        <div className="flex-1 min-w-0 rounded-xl overflow-hidden shadow-lg bg-[#1f2a1d] flex flex-col">
          <div className="flex items-center gap-2 px-4 py-3 bg-[#171f15] border-b border-white/10">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
            <span className="ml-2 flex items-center gap-1.5 text-white/70 text-xs sm:text-sm font-medium">
              <Terminal className="w-3.5 h-3.5" />
              Claude Code
            </span>
          </div>
          <div className="flex-1 px-4 sm:px-5 py-5 sm:py-6 font-mono min-h-[280px] sm:min-h-[320px] flex flex-col justify-center">
            <div key={active.label} className="recall-fade flex flex-col gap-3 sm:gap-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] sm:text-xs uppercase tracking-wider text-[#85AB8B]">{active.label}</span>
                <ModeBadge mode={active.mode} />
              </div>
              <div className="text-xs sm:text-sm leading-relaxed">
                {active.isPlaceholder ? (
                  <span className="italic text-white/50">{active.consoleText}</span>
                ) : (
                  <>
                    <span className="text-[#85AB8B] mr-2">$</span>
                    <span className="text-white">{active.consoleText}</span>
                    <span className="recall-cursor inline-block w-[7px] h-[1em] align-text-bottom ml-1 bg-[#85AB8B]" />
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center py-1 lg:py-0 shrink-0">
          <ArrowRight className="hidden lg:block w-5 h-5 text-[#336443]/40" />
          <ArrowDown className="lg:hidden w-5 h-5 text-[#336443]/40" />
        </div>

        <div className="w-full lg:w-60 shrink-0 rounded-xl bg-white border border-[#336443]/15 shadow-sm px-4 sm:px-5 py-5 sm:py-6 flex flex-col gap-2">
          <span className="text-[10px] sm:text-xs uppercase tracking-wider text-[#336443]/60 font-semibold">
            Tool call
          </span>
          <div key={active.toolName} className="recall-fade flex flex-col gap-1.5">
            <span className="text-sm sm:text-base font-semibold text-[#1f2a1d]">{active.toolName}</span>
            <span className="text-xs sm:text-sm text-[#4b5b47] leading-relaxed">{active.toolDescription}</span>
            <span className="text-xs sm:text-sm text-[#336443]/80 italic leading-relaxed">
              Why it matters: {active.whyItMatters}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-center py-1 lg:py-0 shrink-0">
          <ArrowRight className="hidden lg:block w-5 h-5 text-[#336443]/40" />
          <ArrowDown className="lg:hidden w-5 h-5 text-[#336443]/40" />
        </div>

        <div className="flex-1 min-w-0 rounded-xl overflow-hidden shadow-lg bg-white flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 py-3 bg-[#00684A]">
            <span className="flex items-center gap-1.5 text-white text-xs sm:text-sm font-semibold">
              <Database className="w-3.5 h-3.5" />
              MongoDB Atlas
            </span>
            <span
              key={active.collection}
              className="recall-fade text-white/85 text-[10px] sm:text-xs font-mono"
            >
              {active.collection}
            </span>
          </div>
          <div className="flex-1 px-4 sm:px-5 py-5 sm:py-6 min-h-[280px] sm:min-h-[320px] flex flex-col">
            <span
              key={`${active.collection}-${active.operation}`}
              className="recall-fade inline-flex self-start items-center bg-[#00684A]/10 text-[#00684A] rounded-full px-2 py-0.5 text-xs font-semibold mb-3 sm:mb-4"
            >
              {active.operation}
            </span>
            <pre
              key={active.doc}
              className="recall-fade flex-1 overflow-auto whitespace-pre-wrap break-words text-[#1f2a1d]/85 text-xs sm:text-sm leading-relaxed"
            >
              <code className="font-mono">{active.doc}</code>
            </pre>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 mt-8 sm:mt-10">
        {STEPS.map((step, i) => (
          <span
            key={step.label}
            className={`h-1.5 rounded-full transition-all duration-500 ${
              i === currentStep ? 'w-6 bg-[#336443]' : 'w-1.5 bg-[#336443]/20'
            }`}
          />
        ))}
      </div>
    </section>
  );
}

export default LiveDemoSection;
