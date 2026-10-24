import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import { startOffline } from './offline'
import { initPlatform } from './platform/runtime'
import './styles.css'

initPlatform() // Android: configured server and native storage; browsers: unchanged
startOffline()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
