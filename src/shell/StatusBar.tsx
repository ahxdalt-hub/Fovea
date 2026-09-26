/**
 * StatusBar — always-on reassurance and honest environment readout.
 *
 * Left: the privacy promise (the core promise of the product, visible
 * without opening settings). Right: real facts from the native handshake
 * (OS/arch, app version) and, once the engine has reported, the device
 * enhancements run on. Core connection state is not duplicated here —
 * the top bar pill already shows it.
 */
import { useAppState } from '../state/useAppState'
import { IconShield } from '../ui/Icons'
import './Shell.css'

export function StatusBar() {
  const { state } = useAppState()
  const { systemInfo } = state

  return (
    <footer className="pixora-statusbar">
      <span className="pixora-statusbar__privacy">
        <IconShield size="sm" />
        Everything runs locally. Your images never leave this computer.
      </span>

      <div className="pixora-statusbar__trailing">
        {state.inference && (
          <span className="pixora-statusbar__meta u-tabular">
            {state.inference.device === 'CPU' ? 'CPU' : 'GPU'} ·{' '}
            {state.inference.ready ? 'model ready' : 'model missing'}
          </span>
        )}
        {systemInfo && (
          <span className="pixora-statusbar__meta u-tabular">
            {systemInfo.osFamily} · {systemInfo.arch}
          </span>
        )}
        {state.config && (
          <span className="pixora-statusbar__meta u-tabular">v{state.config.version}</span>
        )}
      </div>
    </footer>
  )
}
