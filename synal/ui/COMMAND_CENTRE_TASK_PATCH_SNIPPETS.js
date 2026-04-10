async function runTask(taskId){return fetch('/api/v1/synal/task-run',{method:'POST',body:JSON.stringify({task_id:taskId})})}
async function autoExecute(taskId){return fetch('/api/v1/synal/auto-execute',{method:'POST',body:JSON.stringify({mode:'single',task_id:taskId})})}
async function refreshTaskState(){return fetch('/api/v1/synal/task-refresh',{method:'POST'})}
