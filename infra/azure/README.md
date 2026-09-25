# The Azure preview estate

Everything a pull request needs to become a running site on an HTTPS URL, and
nothing else. One `terraform apply` provisions Azure **and** sets the twelve
repository variables that point the factory at it.

```bash
az login
infra/azure/apply.sh            # plan: shows what it would do, changes nothing
infra/azure/apply.sh --apply
```

## What it makes

| Resource | Why |
| --- | --- |
| Resource group `rg-factory-preview` | One group, so `az group delete` is a complete uninstall |
| Container registry, Basic | Holds one image tag per open PR. `admin_enabled = false` — there is no registry password |
| Log Analytics workspace | Container Apps can run without one, but then a preview that fails to start says nothing about why |
| Container Apps environment | One environment; every preview app runs in it |
| User-assigned identity + `AcrPull` | What each preview pulls its image with |
| Entra app registration + service principal | What GitHub Actions signs in as |
| Two federated credentials | The OIDC trust. No client secret exists |
| `Contributor` on the group, `Managed Identity Operator` on the identity | The only two roles CI holds |
| Storage account + static website | The launcher: the always-on loading page preview links are wrapped in |

**Not** the preview apps themselves. Those are created per pull request by
`factory preview-up` and destroyed by `factory preview-down`, because their
lifecycle belongs to a PR, not to an estate. Terraform owns what outlives any
one card.

## The one decision worth understanding

`az containerapp create --registry-identity system` — the shape the original
setup notes described — asks Azure to create the app's own identity and then
grant it `AcrPull`. Granting a role is a role assignment, so **the CI principal
has to be able to hand out roles**: `User Access Administrator` on the group,
or nothing works. For a pipeline whose entire argument is that no step holds
more than it needs, giving CI the power to grant itself anything else on the
group is a poor trade.

So the identity is created here instead, granted `AcrPull` once, up front, by
you. CI is then only ever `Contributor` on one resource group plus `Managed
Identity Operator` on one identity — neither of which can create a role
assignment.

`AZURE_PREVIEW_IDENTITY` carries its resource id to `factory/src/azure.ts`,
which passes `--user-assigned` and `--registry-identity`. Leave that variable
unset and the code falls back to `system`, so the old path still works if you
would rather grant the broader role.

## The OIDC subjects

Entra matches the token's subject exactly, so both shapes Actions can present
need a credential:

| Subject | Presented by |
| --- | --- |
| `repo:<owner>/<repo>:pull_request` | `build-setup.yml` on `labeled`/`synchronize`, `build-teardown.yml` on `closed` — the normal path |
| `repo:<owner>/<repo>:ref:refs/heads/main` | `build-setup.yml`'s `workflow_dispatch` retry |

A token from any other repository, branch or event type matches neither and is
refused. Note that the `pull_request` subject does **not** name a branch — that
is how GitHub mints it, not a looseness introduced here.

## The launcher

A preview scales to zero, and Container Apps does not *refuse* a request to a
sleeping app — it holds it open while a replica starts. Measured on a real cold
start: TLS done in 81ms, then 22.4 seconds of silence, then a 200. To whoever
clicked the link that is a blank tab for half a minute, which reads as a broken
deployment rather than a cold one.

Nothing the preview serves can cover that, because the preview is the thing
that is asleep. So `launcher.tf` puts up a page that never sleeps: a storage
account with static website hosting, holding the single HTML file in
`launcher/index.html`. No compute, no deployment token, and it is in the same
resource group, so `az group delete` is still a complete uninstall. Given
`?u=<preview url>` it renders immediately, explains the wait, counts the
seconds, and forwards as soon as the app answers. It refuses to redirect
anywhere outside `*.azurecontainerapps.io`, so it cannot be used as an open
redirect.

Its URL becomes `AZURE_PREVIEW_LAUNCHER`, and the factory wraps **only the
links a human clicks** in it — the kickoff comment, the Jira report, the PR's
"View deployment" button. The URL handed to the agent stays raw, or its "is the
preview serving?" check would be satisfied by the loading page instead of by
the site it is supposed to be testing.

Two other things close the same gap from the other end: `preview-up` now waits
for the app to answer before it returns, so the cold start is spent in CI
rather than in a reviewer's tab, and `AZURE_PREVIEW_COOLDOWN_SECONDS` (default
3600, Azure's default is 300) keeps it awake long enough to survive a review.

## State

Local, in this directory, and gitignored. Fine for one operator.
`.terraform.lock.hcl` **is** committed, so a provider release cannot change
what `apply` does with nobody watching.

The state holds **one** secret, and it is worth being exact about which:
creating a storage account puts its access keys in the state, and the launcher
page is uploaded with one. That key can write to the `$web` container of that
account, which holds one HTML file whose entire content is public by design. It
cannot read a preview, touch the registry, or sign in to anything. Everything
else here is OIDC, where there is no secret to hold. The alternative — keys
disabled and a Microsoft Entra data-plane role — needs a role assignment
created in the same apply that uses it, and role assignments take about a
minute to propagate, so the first apply would fail.

If a second person ever needs to run this, move to an Azure Storage backend
first — otherwise two local states will fight over the same resources.

## What it costs

Idle: the Log Analytics workspace (a few pence a month at this volume), the
Basic registry (~£4/month), the Container Apps environment itself, and the
launcher's storage account (a few kilobytes — rounding error). Preview apps are
created with `--min-replicas 0`, so an app nobody is looking at runs no
replicas and bills nothing.

The cooldown is the only thing here that trades money for speed, and not much
of it. Azure's published uksouth retail rate for a 0.25 vCPU / 0.5 GiB replica
is $0.0108/hour idle, so the default hour of warmth after a build turn costs
about a penny. It still reaches zero on its own afterwards, which is the part
that matters: an open pull request nobody looks at bills nothing, however long
it stays open.

## Taking it down

```bash
infra/azure/apply.sh --destroy
```

Destroy the estate while previews are still running and Terraform will remove
the environment out from under them. Close the open PRs first and let
`build-teardown.yml` clean up, or delete the leftover apps by hand.

`--destroy` also removes the repository variables, which returns the factory to
the `ghcr` stub rather than breaking it.
