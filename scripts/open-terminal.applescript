-- Opens a new Terminal window running one command.
-- Agent Flows runs this as: osascript open-terminal.applescript "<command>"
on run argv
	tell application "Terminal" to do script (item 1 of argv)
end run
