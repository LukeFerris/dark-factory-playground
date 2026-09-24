# The Azure preview estate

Everything a pull request needs to become a running site on an HTTPS URL, and
nothing else. One `terraform apply` provisions Azure **and** sets the ten
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

## State

Local, in this directory, and gitignored. Fine for one operator: the state
names the app registration and the identity but contains no secret, because
with OIDC there is none to contain. `.terraform.lock.hcl` **is** committed, so
a provider release cannot change what `apply` does with nobody watching.

If a second person ever needs to run this, move to an Azure Storage backend
first — otherwise two local states will fight over the same resources.

## What it costs

Idle: the Log Analytics workspace (a few pence a month at this volume), the
Basic registry (~£4/month), and the Container Apps environment itself. Preview
apps are created with `--min-replicas 0`, so an app nobody is looking at runs
no replicas and bills nothing. The trade is a few seconds of cold start on the
first request after idle — worth saying on the PR, because a reviewer who
clicks and sees nothing for four seconds assumes it is broken.

## Taking it down

```bash
infra/azure/apply.sh --destroy
```

Destroy the estate while previews are still running and Terraform will remove
the environment out from under them. Close the open PRs first and let
`build-teardown.yml` clean up, or delete the leftover apps by hand.

`--destroy` also removes the repository variables, which returns the factory to
the `ghcr` stub rather than breaking it.
