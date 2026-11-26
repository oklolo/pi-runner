/** 限制等待时间，不冒充取消底层任务；调用者只可在返回成功后发布结果。 */
export async function withTimeout<T>(operation: Promise<T>, milliseconds: number, error: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(error), milliseconds) })
    ])
  } finally { clearTimeout(timer) }
}
