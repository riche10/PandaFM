import type { RadioPreset } from '../api/radio'
import { toast } from '../library'
import { PresetEditor } from './PresetEditor'
import { closeDialog } from './store'

/** Create or edit a Panda Radio preset from Settings. The server turns these into safe, bounded weights. */
export function PresetDialog({ preset }: { preset: RadioPreset | null }) {
  return (
    <PresetEditor
      preset={preset}
      title={preset ? `Edit ${preset.name}` : 'New radio preset'}
      submitLabel="Save"
      onSaved={(saved) => {
        toast(preset ? `Saved ${saved.name}` : `Created ${saved.name}`)
        closeDialog()
      }}
      onCancel={closeDialog}
    />
  )
}
