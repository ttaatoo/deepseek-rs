// Served as a classic <script>. Must call __ModuleLoader__.load; ESM import/export never registers.
const hostWindow = /** @type {Window & { __ModuleLoader__: { load(config: object): void } }} */ (
  /** @type {unknown} */ (window)
)
hostWindow.__ModuleLoader__.load({
  id: 'dsh-llm-grok',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const RPC_CHANNEL = '/grok'
    const RPC_AUTH_START = 'auth/start'
    const RPC_AUTH_STATUS = 'auth/status'
    const RPC_AUTH_LOGOUT = 'auth/logout'
    const RPC_AUTH_CANCEL = 'auth/cancel'

    const inject = ['slots', 'connection']

    function GrokSection(props) {
      const rpc = props.rpc
      const [status, setStatus] = React.useState({ kind: 'loading' })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [generationRef] = React.useState(() => ({ value: 0 }))
      const [generationVersion, setGenerationVersion] = React.useState(0)

      const refresh = React.useCallback(async (requestGeneration = generationRef.value) => {
        try {
          const result = await rpc.call(RPC_CHANNEL, RPC_AUTH_STATUS, { generation: requestGeneration })
          if (requestGeneration !== generationRef.value) return false
          if (!result.ok) {
            setError(result.error.message)
            setStatus({ kind: 'signed-out' })
            return false
          }
          setError(result.value.kind === 'error' ? result.value.message ?? '登录失败。' : '')
          setStatus(result.value)
          return true
        } catch (cause) {
          if (requestGeneration !== generationRef.value) return false
          setError(cause instanceof Error ? cause.message : String(cause))
          setStatus({ kind: 'signed-out' })
          return false
        }
      }, [rpc])

      React.useEffect(() => {
        const requestGeneration = generationRef.value
        void refresh(requestGeneration).catch(() => {})
      }, [refresh])

      React.useEffect(() => {
        if (status.kind !== 'pending') return undefined
        const requestGeneration = generationRef.value
        const timer = setInterval(() => { void refresh(requestGeneration).catch(() => {}) }, 2000)
        return () => clearInterval(timer)
      }, [status.kind, refresh, generationVersion])

      const run = async (endpoint) => {
        const requestGeneration = ++generationRef.value
        setGenerationVersion(requestGeneration)
        setBusy(true)
        setError('')
        try {
          const result = await rpc.call(RPC_CHANNEL, endpoint, { generation: requestGeneration })
          if (requestGeneration !== generationRef.value) return
          if (!result.ok) {
            setError(result.error.message)
            return
          }
          await refresh(requestGeneration)
        } catch (cause) {
          if (requestGeneration !== generationRef.value) return
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (requestGeneration === generationRef.value) setBusy(false)
        }
      }

      return React.createElement('div', { style: styles.page },
        React.createElement('h2', { style: styles.title }, 'Grok'),
        React.createElement('p', { style: styles.intro },
          '使用 SuperGrok 或 X Premium+ 订阅登录。不使用 xAI Console API Key。'),
        statusLine(status),
        status.kind === 'pending'
          ? React.createElement('div', { style: styles.box },
            React.createElement('p', { style: styles.codeLabel }, '确认码'),
            React.createElement('p', { style: styles.code }, status.userCode ?? ''),
            status.verificationUrl
              ? React.createElement('a', { href: status.verificationUrl, target: '_blank', rel: 'noreferrer' },
                status.verificationUrl)
              : null,
            React.createElement('p', { style: styles.hint },
              '浏览器会打开 xAI 授权页。授权完成后回到这里，状态会自动变成已登录。'),
          )
          : null,
        error || status.kind === 'error'
          ? React.createElement('p', { style: styles.error }, error || status.message)
          : null,
        React.createElement('div', { style: styles.row },
          status.kind === 'signed-in'
            ? React.createElement('button', {
              type: 'button',
              disabled: busy,
              onClick: () => { void run(RPC_AUTH_LOGOUT) },
            }, '退出登录')
            : React.createElement('button', {
              type: 'button',
              disabled: busy,
              onClick: () => { void run(RPC_AUTH_START) },
            }, status.kind === 'pending' ? '重新登录' : '使用 Grok 账号登录'),
          status.kind === 'pending'
            ? React.createElement('button', {
              type: 'button',
              disabled: busy,
              onClick: () => { void run(RPC_AUTH_CANCEL) },
            }, '取消')
            : null,
        ),
        React.createElement('p', { style: styles.hint },
          '登录后新建会话，在模型列表中选择 Grok 4.6 / 4.5。旧会话仍绑定原来的模型。'),
      )
    }

    function statusLine(status) {
      if (status.kind === 'loading') return React.createElement('p', null, '正在读取登录状态…')
      if (status.kind === 'pending') return React.createElement('p', null, '等待浏览器完成授权…')
      if (status.kind === 'signed-in') {
        return React.createElement('p', null, `已登录${status.email ? `：${status.email}` : ''}`)
      }
      return React.createElement('p', null, '未登录')
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 },
      title: { margin: 0, fontSize: 20 },
      intro: { margin: 0, opacity: 0.8 },
      box: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid currentColor' },
      codeLabel: { margin: 0, fontSize: 12, opacity: 0.7 },
      code: { margin: 0, fontSize: 28, letterSpacing: 2, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      row: { display: 'flex', gap: 8 },
      hint: { margin: 0, fontSize: 13, opacity: 0.75 },
      error: { margin: 0, color: '#c0392b' },
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const connection = ctx.get('connection')
      if (slots === undefined || connection === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'grok', order: 85, label: 'Grok' },
        () => React.createElement(GrokSection, { rpc: connection.rpc }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
