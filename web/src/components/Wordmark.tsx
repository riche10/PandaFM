/** The PandaFM wordmark. A page heading on Home and Status; a plain mark in the sidebar. */
export function Wordmark({ size, heading = true }: { size: 'large' | 'small'; heading?: boolean }) {
  const Tag = heading ? 'h1' : 'span'
  return (
    <Tag className={`wordmark wordmark--${size}`} aria-label="PandaFM">
      <span aria-hidden="true">Panda</span>
      <span className="wordmark-fm" aria-hidden="true">
        FM
      </span>
    </Tag>
  )
}
