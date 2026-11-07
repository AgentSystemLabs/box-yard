# Deep task controls: final follow-up validation

Source HEAD: e6089aa546b9abc41b9f611d1b87bd13ebbe2b3a
Public main base: 97a6e9e (includes merged PR #2)
Branch: keep-deeply-nested-task-controls-visible

- npm run typecheck: exit 0
- npm run build: exit 0
- npm run test:fast: exit 0; 267 files, 3126 tests passed; no teardown errors
- Chromium proof: exit 0; 859 checks, zero failures
- Viewports: 320, 400, 560 and 800px, plus the actual persisted 200px column at a 1600px viewport
- Zoom: 100% and 125%; mouse and touch
- Full thirteen-level hierarchy, readable titles (minimum measured width 51px), bounded actions, 44px touch targets, folded counts, true-parent keyboard folding/focus, one tree Tab stop, rail tree and sub-task transcript layout

PR #2 was merged externally during validation. Its branch was not pushed again; this follow-up started from public main. No merge performed by this agent. No full test suite run.
All predecessor public commits were recovered. The original long branch and predecessor WIP ref were absent from the public remote; predecessor workspace/archive unavailable through this runner's tools. Unpublished WIP could not be verified; a Captain archive audit was requested.

## Final fast test output

```

> box-yard@0.1.0 test:fast
> tsx scripts/test-full.ts --tier fast

full vitest lock acquired by task_cc7d5c60ee45/pid 102049; lock wait 0.001s

 RUN  v5.0.5 /workspace/home/tasks/task_cc7d5c60ee45/work


 Test Files  267 passed (267)
      Tests  3126 passed (3126)
   Start at  05:36:41
   Duration  241.99s (tests 62%, import 20%, environment 12%, setup 4%, transform 1%)

    Isolate  267 workers spawned · ~172ms startup each (spawn + environment, per file)
             at least ~45.67s faster with isolate: false — reuses workers across files instead of one per file

vitest finished: exit 0; execution 242.291s (excludes lock wait)
```

## Final browser output

```
Checked 320-100-mouse (drawer; rail is desktop-only)
Checked 320-100-touch (drawer; rail is desktop-only)
Checked 320-125-mouse (drawer; rail is desktop-only)
Checked 320-125-touch (drawer; rail is desktop-only)
Checked 400-100-mouse (drawer; rail is desktop-only)
Checked 400-100-touch (drawer; rail is desktop-only)
Checked 400-125-mouse (drawer; rail is desktop-only)
Checked 400-125-touch (drawer; rail is desktop-only)
Checked 560-100-mouse (drawer; rail is desktop-only)
Checked 560-100-touch (drawer; rail is desktop-only)
Checked 560-125-mouse (drawer; rail is desktop-only)
Checked 560-125-touch (drawer; rail is desktop-only)
Checked 800-100-mouse
Checked 800-100-touch
Checked 800-125-mouse (drawer; rail is desktop-only)
Checked 800-125-touch (drawer; rail is desktop-only)
Checked 1600-100-mouse
Checked 1600-100-touch
Checked 1600-125-mouse
Checked 1600-125-touch
859 checks; 0 failures. Proof: /tmp/sidebar-tree-proof/complete
```
