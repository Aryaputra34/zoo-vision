import cv2
from ultralytics import YOLO

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    
    model = YOLO("yolo26l.pt")
    res = model(frame, classes=[0], conf=0.15, imgsz=1920, verbose=False)[0]
    
    print(f"Total detections on full 1080p frame: {len(res.boxes)}")
    print("Detections inside user zone (x: 1555..1881, y: 151..518):")
    found = 0
    for b in res.boxes:
        conf = float(b.conf[0])
        x1, y1, x2, y2 = [int(x) for x in b.xyxy[0].tolist()]
        # Check overlap with user box [1555, 151, 1881, 518]
        if not (x2 < 1555 or x1 > 1881 or y2 < 151 or y1 > 518):
            found += 1
            print(f"  Found #{found}: conf={conf:.3f}, box={[x1, y1, x2, y2]}")
    if found == 0:
        print("  None found at conf >= 0.15")

if __name__ == "__main__":
    main()
