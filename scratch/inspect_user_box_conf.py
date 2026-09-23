import cv2
from ultralytics import YOLO

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    frame = cv2.imread(img_path)
    
    for m_name in ["yolo26m.pt", "yolo26l.pt"]:
        print(f"\n================ {m_name} ================")
        model = YOLO(m_name)
        for sz in [1280, 1920]:
            res = model(frame, classes=[0], conf=0.08, imgsz=sz, verbose=False)[0]
            in_zone = []
            for b in res.boxes:
                c = float(b.conf[0])
                bx = [int(x) for x in b.xyxy[0].tolist()]
                # User box: [1555, 151, 1881, 518]
                if not (bx[2] < 1555 or bx[0] > 1881 or bx[3] < 151 or bx[1] > 518):
                    in_zone.append((c, bx))
            print(f"imgsz={sz} -> Total in user box: {len(in_zone)}")
            for c, bx in in_zone:
                print(f"   conf={c:.3f}, box={bx}")

if __name__ == "__main__":
    main()
