// Imported first by main.tsx, so the platform (web or Android, native player or
// not) is known before any module creates the player. ES modules evaluate their
// imports before the importing module's own code, so calling initPlatform() in
// main.tsx itself would be too late.
import { initPlatform } from './runtime'

initPlatform()

import { startNetworkWatch } from './network'
startNetworkWatch()
