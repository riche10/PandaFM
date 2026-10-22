import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

// Shell-level UI state that isn't about playback: whether the desktop queue
// panel is open. (On phones the queue is its own page at /queue.)
const uiStore = createStore<{ queueOpen: boolean }>()(() => ({ queueOpen: false }))

export const useQueueOpen = () => useStore(uiStore, (s) => s.queueOpen)
export const toggleQueuePanel = () => uiStore.setState((s) => ({ queueOpen: !s.queueOpen }))
export const closeQueuePanel = () => uiStore.setState({ queueOpen: false })
