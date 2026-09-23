import cv2

def main():
    img_path = r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\restoran_26_53_raw.jpg"
    img = cv2.imread(img_path)
    if img is None:
        print("Image not found")
        return
    h, w = img.shape[:2]
    # Crop top right: x from w//2 to w, y from 0 to h//2
    top_right = img[0:int(h*0.6), int(w*0.5):w]
    cv2.imwrite(r"c:\Users\Magnet Busdev-2\Documents\temp\zoo-monitor\scratch\crop_top_right.jpg", top_right)
    print("Saved crop_top_right.jpg")

if __name__ == "__main__":
    main()
