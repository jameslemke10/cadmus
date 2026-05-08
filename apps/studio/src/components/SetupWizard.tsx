"use client";

interface ProviderStatus {
  configured: boolean;
  needed: boolean;
}

interface Status {
  providers: {
    google: ProviderStatus;
    anthropic: ProviderStatus;
  };
  modelsInUse: string[];
}

interface Props {
  status: Status;
  onDismiss: () => void;
}

export function SetupWizard({ status, onDismiss }: Props) {
  const missing: Array<"google" | "anthropic"> = [];
  if (status.providers.google.needed && !status.providers.google.configured) missing.push("google");
  if (status.providers.anthropic.needed && !status.providers.anthropic.configured) missing.push("anthropic");

  if (missing.length === 0) return null;

  return (
    <div className="fixed inset-0 bg-stone-900/40 z-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        <header className="px-6 pt-6 pb-3 border-b border-stone-100">
          <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold mb-2">
            Setup needed
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Add an API key to start
          </h2>
          <p className="mt-2 text-sm text-stone-600 leading-relaxed">
            Your agent uses{" "}
            <span className="font-mono text-stone-800">
              {status.modelsInUse.join(", ") || "(none)"}
            </span>{" "}
            but{" "}
            {missing.length === 2
              ? "neither GOOGLE_API_KEY nor ANTHROPIC_API_KEY is set"
              : missing[0] === "google"
                ? "GOOGLE_API_KEY isn't set"
                : "ANTHROPIC_API_KEY isn't set"}
            .
          </p>
        </header>

        <div className="px-6 py-5 space-y-4">
          {missing.includes("google") && (
            <ProviderRow
              name="Google Gemini"
              env="GOOGLE_API_KEY"
              link="https://aistudio.google.com/apikey"
              linkLabel="aistudio.google.com/apikey"
              tagline="Free tier, no credit card."
            />
          )}
          {missing.includes("anthropic") && (
            <ProviderRow
              name="Anthropic Claude"
              env="ANTHROPIC_API_KEY"
              link="https://console.anthropic.com/settings/keys"
              linkLabel="console.anthropic.com/settings/keys"
              tagline="Pay-per-use."
            />
          )}

          <div className="bg-stone-50 border border-stone-200 rounded-lg p-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-stone-400 font-semibold">
              Then:
            </div>
            <ol className="text-sm text-stone-700 space-y-1.5 list-decimal list-inside">
              <li>
                Add the key to{" "}
                <code className="bg-white border border-stone-200 px-1.5 py-0.5 rounded text-[12px] font-mono">
                  .env.local
                </code>{" "}
                in your agent directory.
              </li>
              <li>
                Restart{" "}
                <code className="bg-white border border-stone-200 px-1.5 py-0.5 rounded text-[12px] font-mono">
                  cadmus start
                </code>
                .
              </li>
            </ol>
          </div>
        </div>

        <footer className="px-6 py-3 border-t border-stone-100 flex justify-between items-center">
          <button
            onClick={onDismiss}
            className="text-stone-500 hover:text-stone-700 text-sm font-medium transition"
          >
            Continue without
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition"
          >
            I added the key — recheck
          </button>
        </footer>
      </div>
    </div>
  );
}

function ProviderRow({
  name,
  env,
  link,
  linkLabel,
  tagline,
}: {
  name: string;
  env: string;
  link: string;
  linkLabel: string;
  tagline: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1">
        <div className="font-semibold text-sm">{name}</div>
        <div className="text-xs text-stone-500 mt-0.5">{tagline}</div>
        <div className="mt-1.5 text-xs text-stone-700">
          <code className="font-mono bg-stone-100 px-1.5 py-0.5 rounded">{env}</code>
          <span className="mx-1.5 text-stone-400">·</span>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-700"
          >
            {linkLabel} →
          </a>
        </div>
      </div>
    </div>
  );
}
