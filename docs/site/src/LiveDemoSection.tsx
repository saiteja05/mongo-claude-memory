import { useEffect, useState } from 'react';
import { Terminal, Database } from 'lucide-react';

type Step = {
  ccLabel: string;
  ccLog: string;
  collection: string;
  operation: string;
  doc: string;
};

const STEPS: Step[] = [
  {
    ccLabel: 'UserPromptSubmit hook',
    ccLog: 'hash-line captured: "ship uses trunk-based branching, no long-lived feature branches"',
    collection: 'claude_memory.observations',
    operation: 'insertOne',
    doc: `db.observations.insertOne({
  project: "ship",
  source: "hash_line",
  priority: "high",
  status: "pending",
  text: "ship uses trunk-based branching, no long-lived feature branches"
})`,
  },
  {
    ccLabel: 'SessionEnd hook',
    ccLog: 'Session ended, capturing last 50000 chars of transcript',
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
    ccLabel: 'Consolidator (cron, every 15 min)',
    ccLog: 'Claiming pending observations for project ship',
    collection: 'claude_memory.observations',
    operation: 'updateMany',
    doc: `db.observations.updateMany(
  { status: "pending" },
  {
    $set: {
      status: "claimed",
      run_id: "run_8f2a1c",
      claimed_at: ISODate("2026-07-10T14:32:00Z")
    }
  }
)`,
  },
  {
    ccLabel: 'Consolidator, fact extraction',
    ccLog: 'Extracted fact, deduped against existing beliefs',
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
    ccLabel: 'memory_search MCP tool call',
    ccLog: 'Hybrid recall requested mid-session',
    collection: 'claude_memory.beliefs',
    operation: 'aggregate ($rankFusion)',
    doc: `db.beliefs.aggregate([
  {
    $rankFusion: {
      input: {
        pipelines: {
          vectorPipeline: [
            { $vectorSearch: { path: "embedding", index: "beliefs_vector" } }
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
    ccLabel: 'SessionStart hook (next session)',
    ccLog: 'Brief injected as additionalContext',
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

const STEP_INTERVAL_MS = 3200;

function LiveDemoSection() {
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setCurrentStep((s) => (s + 1) % STEPS.length);
    }, STEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const active = STEPS[currentStep];

  return (
    <section className="relative w-full bg-[#f7f5ef] py-16 sm:py-20 md:py-28 px-4 sm:px-6">
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
          How it works
        </span>
        <h2
          className="font-normal leading-[1.05] text-[#336443] text-2xl sm:text-3xl md:text-4xl max-w-3xl mx-auto"
          style={{
            fontFamily:
              '"Neue Haas Grotesk Display Pro 55 Roman", "Neue Haas Grotesk Text Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
            letterSpacing: '-0.03em',
          }}
        >
          Capture, consolidate, retrieve. One Atlas pipeline.
        </h2>
        <p className="mt-3 sm:mt-4 text-[#4b5b47] text-sm sm:text-base max-w-xl mx-auto">
          Every hook, cron run, and tool call on the left maps to a real write or query on the right: no invented steps.
        </p>
      </div>

      <div className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Claude Code window */}
        <div className="rounded-xl overflow-hidden shadow-lg bg-[#1f2a1d] flex flex-col">
          <div className="flex items-center gap-2 px-4 py-3 bg-[#171f15] border-b border-white/10">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f56]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#ffbd2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27c93f]" />
            <span className="ml-2 flex items-center gap-1.5 text-white/70 text-xs sm:text-sm font-medium">
              <Terminal className="w-3.5 h-3.5" />
              Claude Code
            </span>
          </div>
          <div className="flex-1 px-4 sm:px-5 py-5 sm:py-6 font-mono min-h-[280px] sm:min-h-[320px]">
            <div className="flex flex-col gap-3 sm:gap-4">
              {STEPS.map((step, i) => {
                const isPast = i < currentStep;
                const isCurrent = i === currentStep;
                const isFuture = i > currentStep;
                return (
                  <div
                    key={step.ccLabel}
                    className={`transition-opacity duration-500 ${isFuture ? 'opacity-0' : 'opacity-100'}`}
                  >
                    <div
                      className={`text-[10px] sm:text-xs uppercase tracking-wider mb-1 transition-colors duration-500 ${
                        isCurrent ? 'text-[#85AB8B]' : 'text-white/30'
                      }`}
                    >
                      {step.ccLabel}
                    </div>
                    <div
                      className={`text-xs sm:text-sm leading-relaxed transition-colors duration-500 ${
                        isCurrent ? 'text-white' : isPast ? 'text-white/30' : 'text-white/0'
                      }`}
                    >
                      <span className="text-[#85AB8B] mr-2">$</span>
                      {step.ccLog}
                      {isCurrent && (
                        <span className="recall-cursor inline-block w-[7px] h-[1em] align-text-bottom ml-1 bg-[#85AB8B]" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT: MongoDB Atlas window */}
        <div className="rounded-xl overflow-hidden shadow-lg bg-white flex flex-col">
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
            key={step.ccLabel}
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
