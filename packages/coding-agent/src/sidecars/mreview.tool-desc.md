Review a markdown file with the user in a browser UI with annotation tools and AI chat.

<conditions>
- User asks to review, discuss, annotate, or comment on a markdown file
- User types .review
</conditions>

<critical>
- file_path is **required** - **MUST NOT** call with an empty argument object {}
- file_path **MUST** be an absolute path
- After this tool returns, **do NOT generate any response** - stay completely silent.
  The TUI handles opening the review UI internally after the turn completes.
</critical>
