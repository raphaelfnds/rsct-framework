<!-- RSCT fixture: a registered application in the sample universe. -->
# registered-app

Fixture app dir — its presence makes `registered-app` the ground-truth registered
application (the `applications/<app>/` dir is the source of truth; `.universe.json`
`registered_apps[]` is the index). `ghost-app` is listed in the index but has no
dir, to exercise the registry-reconciliation note.
