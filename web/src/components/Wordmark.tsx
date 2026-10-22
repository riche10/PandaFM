export function Wordmark({ size }: { size: 'large' | 'small' }) {
  return (
    <h1 className={`wordmark wordmark--${size}`} aria-label="PandaFM">
      <span>Panda</span>
      <span className="wordmark-fm">FM</span>
    </h1>
  )
}
