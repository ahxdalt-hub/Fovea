/**
 * NavRail — primary navigation.
 *
 * Icon-over-label vertical rail (Photoshop/Figma convention): fast visual
 * scanning, no collapsed/expanded state machine, room for future sections.
 * Active state is marked by an accent edge bar + tinted glyph, never color
 * alone. Settings is reachable from the top bar, not duplicated here.
 */
import type { ViewId } from '../state/appReducer'
import { cx } from '../ui/cx'
import { IconHistory, IconLayers, IconTune } from '../ui/Icons'
import './Shell.css'

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof IconTune }> = [
  { id: 'enhance', label: 'Enhance', icon: IconTune },
  { id: 'batch', label: 'Batch', icon: IconLayers },
  { id: 'history', label: 'History', icon: IconHistory },
]

export interface NavRailProps {
  active: ViewId
  onNavigate: (view: ViewId) => void
}

export function NavRail({ active, onNavigate }: NavRailProps) {
  return (
    <nav className="fovea-navrail" aria-label="Primary">
      <ul className="fovea-navrail__list">
        {NAV_ITEMS.map((item, index) => {
          const Icon = item.icon
          const isActive = active === item.id
          return (
            <li key={item.id}>
              <button
                type="button"
                className={cx('fovea-navrail__item', isActive && 'fovea-navrail__item--active')}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
              >
                <span className="fovea-navrail__glyph">
                  <Icon size="lg" />
                </span>
                <span className="fovea-navrail__label">{item.label}</span>
                <kbd className="fovea-navrail__key u-tabular">{index + 1}</kbd>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
