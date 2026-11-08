// All non-GETs stop here. These API responses are made-up browser data, never saved settings.
export async function fixtureRoutes(page) {
  await page.route('**/api/**', async (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/api/boot' || url.pathname === '/api/stream') return r.abort()
    if (url.pathname === '/api/connectors/con_example/oauth/start') return r.fulfill({ json: { authorizeUrl:'https://example.com/sign-in', redirectUri:'http://localhost:4000/api/connectors/oauth/callback', mode:'paste', signInHost:'example.com', note:'Example mock sign in.' } })
    if (url.pathname === '/api/identities/idn_example' && r.request().method() === 'PATCH') return r.fulfill({status:400,json:{error:'Example validation error: review the fields.',fields:[{path:'author.name',message:'Example author validation error.'}]}})
    if (r.request().method() !== 'GET') return r.fulfill({ status: 400, json: { error: 'Example validation error: review the fields.' } })
    if (/^\/api\/tasks\/task_contrast-[a-z_]+\/pr$/.test(url.pathname)) return r.fulfill({json:{details:{url:'https://github.com/acme/example-app/pull/1',number:1,title:'Example pull request',state:'draft',mergedAt:null,mergedBy:null,base:'main',head:'example-change',headSha:null,checks:{state:'failing',passed:1,failed:1,pending:1,skipped:1,list:[{name:'Example passing check',state:'passed',url:'https://example.com/check'},{name:'Example failed check',state:'failed',url:'https://example.com/check'},{name:'Example running check',state:'pending',url:null},{name:'Example skipped check',state:'skipped',url:null}]},merge:'conflicts',review:'changes_requested',files:{changed:3,additions:24,deletions:6}},error:null,checkedAt:Date.now()}})
    if (url.pathname === '/api/identities') {
      const identity = { id: 'idn_example', name: 'Example identity', color: 'rose', isDefault: false, githubLogin: 'example-user', githubId: 1, owners: ['acme'], tokens: [{ owner: 'acme', fingerprint: 'example-fingerprint', login: 'example-user', scopes: null, expiresAt: Date.now()+86400000, source: 'pasted', readable: false, savedAt: 1 }], author: { name: 'Example Author', email: 'author@example.com', emailCheck: 'unverified' }, signing: null, claude: null, runners: null, coordinatorSees: 'everything', projectIds: [], lastCheck: { at: Date.now(), ok: false, lines: ['Example token cannot be read. Save it again.', 'Example author email is unverified.'] }, createdAt: 1, updatedAt: 1 }
      return r.fulfill({ json: [{ ...identity, id: 'idn_default', name: 'Default', color: 'slate', isDefault: true, tokens: [], author: null, githubLogin: null, lastCheck: null }, identity] })
    }
    if (url.pathname === '/api/connectors') return r.fulfill({ json: [{ id:'con_example', name:'example', label:'Example connector', preset:null, kind:'http', url:'https://example.com/mcp', command:null, args:[], env:{}, auth:'oauth', header:{name:'Authorization',prefix:'Bearer '}, tokenEnv:null, oauth:{clientKind:'dynamic',clientId:null,hasClientSecret:false,issuer:'https://example.com',signInHost:'example.com',scopes:[],grantedScopes:null,authParams:{},refreshable:false,expiresAt:null,redirectUri:null,signedInAt:null}, secrets:[], scope:{sessions:['coordinator'],projects:null,runners:['local']}, enabled:true,status:'needs_auth',statusDetail:null,lastTest:null,sealedSkipped:[],createdAt:1,updatedAt:1 }] })
    if (url.pathname === '/api/hooks') return r.fulfill({ json: [{ id: 'hook_contrast', name: 'Example paused automation', projectId: null, trigger: 'task.finished', filters: {}, action: 'send_to_task', taskTitle: null, prompt: 'Example instructions remain readable while this hook is off.', enabled: false, allowSelfTrigger: false, maxFiresPerTask: 1, template: null, createdBy: 'Example', createdAt: 1, updatedAt: 1, lastRun: null }] })
    if (url.pathname === '/api/tasks' || /^\/api\/tasks\/task_contrast-[a-z_]+$/.test(url.pathname)) {
      const response = await r.fetch(), data = await response.json()
      const patch = (task) => {
        const status = task.id?.replace('task_contrast-', '')
        return ['queued', 'starting', 'working'].includes(status) ? { ...task, status } : task
      }
      return r.fulfill({ json: Array.isArray(data) ? data.map(patch) : patch(data) })
    }
    if (url.pathname === '/api/tasks/task_contrast-idle/queue') return r.fulfill({ json: ['queued', 'delivering', 'accepted', 'uncertain'].map((status, i) => ({ id: `qm_example-${i}`, taskId: 'task_contrast-idle', text: 'Example queued message.', sender: 'Example', source: 'cody', attachments: [], status, createdAt: Date.now() - 60000, updatedAt: Date.now() })) })
    if (url.pathname === '/api/agent-settings' || url.pathname === '/api/settings') {
      const data = await r.fetch().then((r) => r.json())
      return r.fulfill({ json: { ...data, settings: { ...data.settings, showCloudMeter: true } } })
    }
    return r.continue()
  })
}
