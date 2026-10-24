import './platform/boot' // first: decides web vs Android before the player is created
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import { startAppearance } from './appearance/apply'
import { startOffline } from './offline'
import './styles.css'

startAppearance() // theme before the first render
startOffline()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
