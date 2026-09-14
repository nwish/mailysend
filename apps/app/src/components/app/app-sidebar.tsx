import { cn, Kbd } from '@mailysend/ui'
import { Link, useRouterState } from '@tanstack/react-router'
import { NAV } from './nav.ts'

/**
 * The primary navigation landmark. Rendered as `nav > ul > li > a` so a screen
 * reader can list it and skip it; the active item carries `aria-current`
 * rather than only a background colour.
 */
export const AppSidebar = ({ onNavigate }: { onNavigate?: () => void }) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  const isActive = (to: string): boolean =>
    to === '/app' ? pathname === '/app' || pathname === '/app/' : pathname.startsWith(to)

  return (
    <nav
      aria-label="Dashboard"
      className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-3 py-5"
    >
      {NAV.map((group) => (
        <div key={group.label}>
          <h2 className="ms-eyebrow px-3 pb-2.5 text-[10px] text-muted-2">{group.label}</h2>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {group.items.map((item) => {
              const active = isActive(item.to)
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-md border border-transparent px-3 py-2.5 text-[14px]',
                      'transition-[background-color,color,border-color,box-shadow] duration-[0.18s]',
                      active
                        ? 'border-line bg-card font-semibold text-ink shadow-sm'
                        : 'text-muted hover:bg-card/70 hover:text-ink',
                    )}
                  >
                    <item.icon
                      className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-muted-2')}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.chord ? (
                      <Kbd
                        keys={['G', item.chord.toUpperCase()]}
                        className="opacity-0 transition-opacity duration-[0.18s] group-hover:opacity-100 group-focus-visible:opacity-100"
                      />
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
