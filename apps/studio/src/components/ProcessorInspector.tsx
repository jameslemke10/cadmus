"use client";

import { useEffect } from "react";
import type { ProcessorMeta } from "../lib/types";
import { filterEntryLabel } from "../lib/filter";

interface Props {
  processor: ProcessorMeta | null;
  recentEvents: number;
  onClose: () => void;
}

export function ProcessorInspector({ processor, recentEvents, onClose }: Props) {
  useEffect(() => {
    if (!processor) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [processor, onClose]);

  if (!processor) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-stone-900/20 z-30 transition-opacity"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 bottom-0 w-[440px] bg-white border-l border-stone-200 z-40 flex flex-col shadow-2xl">
        <header className="px-5 py-4 border-b border-stone-200 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
              Processor
            </div>
            <h2 className="text-xl font-semibold tracking-tight">{processor.name}</h2>
            <div className="mt-1 flex items-center gap-2 text-xs text-stone-500">
              <span className="font-mono">{processor.template}</span>
              {processor.template === "llm" && processor.templateConfig?.model && (
                <>
                  <span>·</span>
                  <span className="font-mono">{processor.templateConfig.model}</span>
                </>
              )}
              <span>·</span>
              <span>{recentEvents} firings</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-700 transition px-2 -mr-2"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <Section label="Listens to (filter)">
            <ChipList
              items={processor.filter.map(filterEntryLabel)}
              colorClass="bg-stone-100 text-stone-700"
            />
          </Section>

          {processor.outputEvents.length > 0 && (
            <Section label="Emits">
              <ChipList
                items={processor.outputEvents}
                colorClass="bg-emerald-50 text-emerald-800 border border-emerald-100"
              />
            </Section>
          )}

          {processor.tools.length > 0 && (
            <Section label="Tools">
              <ChipList
                items={processor.tools}
                colorClass="bg-amber-50 text-amber-800 border border-amber-100"
              />
            </Section>
          )}

          {processor.template === "llm" && processor.templateConfig?.systemPrompt && (
            <Section label="System prompt">
              <pre className="text-[12px] font-mono bg-stone-50 border border-stone-200 rounded p-3 whitespace-pre-wrap leading-relaxed text-stone-800 max-h-96 overflow-y-auto">
                {processor.templateConfig.systemPrompt}
              </pre>
            </Section>
          )}

          {processor.template === "llm" && processor.templateConfig && (
            <Section label="Settings">
              <dl className="grid grid-cols-[120px_1fr] gap-y-1 text-xs">
                {processor.templateConfig.temperature !== undefined && (
                  <KeyValue
                    k="temperature"
                    v={String(processor.templateConfig.temperature)}
                  />
                )}
                {processor.templateConfig.maxIterations !== undefined && (
                  <KeyValue
                    k="maxIterations"
                    v={String(processor.templateConfig.maxIterations)}
                  />
                )}
                {processor.templateConfig.contextEvents !== undefined && (
                  <KeyValue
                    k="contextEvents"
                    v={String(processor.templateConfig.contextEvents)}
                  />
                )}
              </dl>
            </Section>
          )}

          {processor.outputSchema && Object.keys(processor.outputSchema).length > 0 && (
            <Section label="Output schemas">
              <pre className="text-[11px] font-mono bg-stone-50 border border-stone-200 rounded p-3 whitespace-pre-wrap overflow-x-auto text-stone-700 max-h-72 overflow-y-auto">
                {JSON.stringify(processor.outputSchema, null, 2)}
              </pre>
            </Section>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-stone-200 text-[11px] text-stone-400">
          Editable in the next release. For now, edit{" "}
          <code className="font-mono text-stone-600">cadmus.config.ts</code> and restart.
        </footer>
      </aside>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function ChipList({ items, colorClass }: { items: string[]; colorClass: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className={`text-[11px] font-mono px-2 py-1 rounded ${colorClass}`}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="font-mono text-stone-500">{k}</dt>
      <dd className="font-mono text-stone-800">{v}</dd>
    </>
  );
}
