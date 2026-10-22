import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

// Short confirmations and errors ("Added to Favorites"), shown above the player.

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
}

interface ToastState {
  toasts: Toast[]
}

const TOAST_MS = 3500
let nextId = 1

export const toastStore = createStore<ToastState>()(() => ({ toasts: [] }))

export function toast(message: string, tone: Toast['tone'] = 'info'): void {
  const id = nextId++
  toastStore.setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, tone }] }))
  setTimeout(() => dismissToast(id), TOAST_MS)
}

export function dismissToast(id: number): void {
  toastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export const useToasts = () => useStore(toastStore, (s) => s.toasts)
