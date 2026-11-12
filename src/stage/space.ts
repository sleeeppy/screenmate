/**
 * 화면(CSS px, y 아래로 증가) ↔ 월드(모델 단위, y 위로 증가) 변환.
 *
 * 월드 원점은 화면 왼쪽 아래 모서리다. 캐릭터는 월드에서 실제로 움직이고
 * 카메라와 캔버스가 따라간다. 그래야 걷기·던지기 때 물리(머리카락·옷)가 반응한다.
 */
export class StageSpace {
  constructor(
    public stageHeight: number,
    /** 1 모델 단위가 몇 CSS px인지 (= 목표 키 / 頭 높이) */
    public pixelsPerUnit: number,
  ) {}

  toWorld(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: cssX / this.pixelsPerUnit,
      y: (this.stageHeight - cssY) / this.pixelsPerUnit,
    };
  }

  toCss(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: worldX * this.pixelsPerUnit,
      y: this.stageHeight - worldY * this.pixelsPerUnit,
    };
  }
}
