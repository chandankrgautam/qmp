# Colony Maintenance Portal

The project's documentation lives in three files, imported below; keep
them current instead of adding new ones. README.md holds what the
application is and the business decisions; design-decisions.md how the
Claude Design handover (`Design_System/`) became the web portal (`web/`)
and why; development_logs.md setup, commands, credentials, defects and the
change log.

Before changing anything, read README.md section 4 (the nine controls). If
a change would relax one, stop and raise it rather than proceeding.

Before building or changing a screen, look at its reference image in
`Design_System/screenshots/` and the prototype in `Design_System/designs/`,
reuse components from `web/src/components/ui`, then open the screen in the
browser and compare it with the mockup. Where the design and a project
decision disagree, the project decision wins. Change the backend only
when there is no other way.

@README.md
@design-decisions.md
@development_logs.md
