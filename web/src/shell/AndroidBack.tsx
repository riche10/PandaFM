import { App } from '@capacitor/app'
import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { handleBack } from '../platform/back'
import { playerStore } from '../player'

/** Android only: the system Back button navigates PandaFM instead of closing it. */
export function AndroidBack() {
  const navigate = useNavigate()
  useEffect(() => {
    const listener = App.addListener('backButton', () => {
      handleBack({
        pathname: () => window.location.pathname,
        historyIndex: () => (window.history.state as { idx?: number } | null)?.idx ?? 0,
        goBack: () => navigate(-1),
        goHome: () => navigate('/', { replace: true }),
        hasMusic: () => playerStore.getState().items.length > 0,
        minimize: () => void App.minimizeApp(),
        exit: () => void App.exitApp(),
      })
    })
    return () => {
      void listener.then((l) => l.remove())
    }
  }, [navigate])
  return null
}
