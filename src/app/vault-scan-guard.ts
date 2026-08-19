/**
 * `suppressVaultScan` 카운터를 캡슐화한다.
 *
 * 번역 파일 쓰기, 로어북 가져오기, 메타데이터 갱신 등 Scriptorium이
 * 스스로 발생시킨 vault 변경이 다시 검사를 유발하지 않도록 잠시 검사를
 * 억제할 때 쓴다. 단순 boolean이 아니라 카운터이므로 중첩 호출에 안전하다.
 */
export class VaultScanGuard {
  private counter = 0;

  isSuppressed(): boolean {
    return this.counter > 0;
  }

  /**
   * 카운터를 1 올린 뒤 action을 실행하고, 성공/실패 여부와 관계없이
   * finally에서 카운터를 1 내린다. 중첩 호출 시 각 단계마다 증감되므로
   * 가장 바깥 호출이 끝나야 비로소 억제가 풀린다.
   */
  async withSuppressed<T>(action: () => Promise<T>): Promise<T> {
    this.counter += 1;
    try {
      return await action();
    } finally {
      this.counter -= 1;
    }
  }
}