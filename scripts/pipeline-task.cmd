@echo off
rem Scheduled daily pipeline run (Windows Task Scheduler task: oddspro-pipeline).
rem Appends output to logs\pipeline.log (gitignored). Manage the schedule with:
rem   schtasks /query  /tn oddspro-pipeline
rem   schtasks /change /tn oddspro-pipeline /st HH:MM
rem   schtasks /delete /tn oddspro-pipeline /f
cd /d %~dp0..
if not exist logs mkdir logs
echo [%date% %time%] pipeline start >> logs\pipeline.log
call npm run start >> logs\pipeline.log 2>&1
echo [%date% %time%] pipeline exit %errorlevel% >> logs\pipeline.log
