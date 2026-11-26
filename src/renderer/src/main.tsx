import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { AppErrorBoundary } from './components/AppErrorBoundary'

createRoot(document.getElementById('root')!).render(<React.StrictMode><AppErrorBoundary><TooltipProvider delayDuration={300}><App /></TooltipProvider></AppErrorBoundary></React.StrictMode>)
