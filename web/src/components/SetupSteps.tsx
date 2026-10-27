const STEPS = ['Welcome', 'Owner account', 'Music server', 'Import', 'Ready']

/** First-run progress: where you are in setting PandaFM up. */
export function SetupSteps({ current }: { current: number }) {
  return (
    <ol className="setup-steps" aria-label="Setup progress">
      {STEPS.map((label, i) => (
        <li key={label} aria-current={i === current ? 'step' : undefined} data-done={i < current || undefined}>{label}</li>
      ))}
    </ol>
  )
}
