// dsh-novel-conductor 的 Web 半：会话头「故事总控」开关按钮。
// 只做一件事：读 remote 的接管状态、点一下切 on/off；其余状态都在 Host。

window.__ModuleLoader__.load({
  id: 'dsh-novel-conductor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function scalar(validate) {
      return {
        parse(value) {
          validate(value)
          return value
        },
        safeParse(value) {
          try {
            validate(value)
            return { success: true, data: value }
          } catch (error) {
            return { success: false, error }
          }
        },
      }
    }

    const sessionIdSchema = scalar((value) => {
      if (typeof value !== 'string' || value.length === 0) throw new Error('sessionId must be a non-empty string')
    })
    const booleanSchema = scalar((value) => {
      if (typeof value !== 'boolean') throw new Error('on must be a boolean')
    })
    const modeResultSchema = scalar((value) => {
      if (!value || typeof value.on !== 'boolean') throw new Error('result must be { on: boolean }')
    })
    const codec = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, create: () => schema })
    const param = (name, schema) => ({ name, wire: name, source: 'json', codec: codec(name, schema) })

    const TYPERT_REMOTE = {
      package: 'dsh-novel-conductor',
      descriptors: [
        {
          id: 'dsh-novel-conductor#cueMode/status', namespace: 'cueMode', service: 'cueMode', method: 'status',
          invocation: { kind: 'direct' }, parameters: [param('sessionId', sessionIdSchema)],
          result: codec('CueMode', modeResultSchema),
        },
        {
          id: 'dsh-novel-conductor#cueMode/setMode', namespace: 'cueMode', service: 'cueMode', method: 'setMode',
          invocation: { kind: 'direct' }, parameters: [param('sessionId', sessionIdSchema), param('on', booleanSchema)],
          result: codec('CueMode', modeResultSchema),
        },
      ],
    }

    function sessionIdOf(value) {
      if (typeof value === 'string') return value
      if (!value) return null
      return value.id ?? value.sessionId ?? String(value)
    }

    function CueModeButton({ sessionId, remote }) {
      const sid = sessionIdOf(sessionId)
      const [state, setState] = React.useState({ on: null, busy: false, error: null })
      const busyRef = React.useRef(false)
      const seq = React.useRef(0)
      const lastSid = React.useRef(null)

      const call = async (action) => {
        if (!sid) throw new Error('拿不到当前会话')
        if (!remote || typeof remote[action === 'status' ? 'status' : 'setMode'] !== 'function') {
          throw new Error('remote 未就绪')
        }
        const result = action === 'status'
          ? await remote.status(sid)
          : await remote.setMode(sid, action === 'on')
        if (result && result.ok === false) throw new Error(result.error?.message ?? 'remote 调用失败')
        const value = result && result.ok === true ? result.value : result
        if (!value || typeof value.on !== 'boolean') throw new Error('remote 回执缺 on')
        return value.on
      }

      const run = async (action, silent) => {
        if (busyRef.current && !silent) return
        const my = ++seq.current
        if (!silent) {
          busyRef.current = true
          setState((prev) => ({ ...prev, busy: true, error: null }))
        }
        try {
          const on = await call(action)
          if (my !== seq.current) return
          busyRef.current = false
          setState({ on, busy: false, error: null })
        } catch (error) {
          if (my !== seq.current) return
          busyRef.current = false
          const message = String(error?.message ?? error)
          if (!silent) console.error('[novel-conductor] 切换失败', message)
          setState((prev) => silent ? { ...prev, busy: false } : { ...prev, busy: false, error: message })
        }
      }

      React.useEffect(() => {
        if (!sid || lastSid.current === sid) return
        lastSid.current = sid
        run('status', true)
      }, [sid])

      const short = state.error ? String(state.error).slice(0, 6) : ''
      const label = state.on === true
        ? '故事总控：开'
        : state.on === false
          ? '故事总控：关'
          : state.error
            ? `故事总控！${short}`
            : '故事总控'
      const style = {
        height: 24,
        marginRight: 6,
        padding: '0 8px',
        borderRadius: 6,
        border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
        background: state.on ? 'var(--cue-brand, #2f6f5e)' : 'transparent',
        color: state.on ? '#ffffff' : 'inherit',
        fontSize: 12,
        lineHeight: '22px',
        cursor: 'pointer',
        opacity: state.busy ? 0.65 : 1,
      }

      return h('button', {
        type: 'button',
        style,
        title: state.error ?? '故事总控：开 = 本会话调度 beat / fade / voice / fanfic；关 = 四个插件全部不工作（/cue on | /cue off）',
        'aria-pressed': state.on === true,
        'aria-busy': state.busy,
        'aria-label': state.error ? `${label}：${state.error}` : label,
        onClick: () => {
          if (busyRef.current) return
          run(state.on ? 'off' : 'on', false)
        },
      }, state.busy ? '…' : label)
    }

    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        let remote = null
        try {
          const dispose = await ctx.remote.$mount(TYPERT_REMOTE)
          remote = ctx.get('remote.cueMode') ?? null
          if (typeof dispose === 'function') {
            ctx.effect(() => () => {
              try {
                dispose()
              } catch {
                // 已经卸载
              }
            })
          }
          if (!remote) console.error('[novel-conductor] remote.cueMode 未注册')
        } catch (error) {
          console.error('[novel-conductor] remote mount 失败', error)
        }

        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-novel-conductor-mode',
          order: 34,
          inject: (sessionId) => ({ sessionId, remote }),
        }, CueModeButton)))
      },
    }
  },
})
